import json
import boto3
import io
import os
import subprocess
import tempfile
from PIL import Image
import fitz  # PyMuPDF
import requests
from typing import List, Dict


# Initialize AWS clients
s3_client = boto3.client('s3')

# Environment variables
BUCKET_NAME = 'vmtb-bedrock-qwen-bucket-v2'
EXTRACT_LAMBDA_API = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/extract'
ANONYMIZE_LAMBDA_API = 'https://trigger-ocr-service-622331214924.asia-south1.run.app/trigger'

def lambda_handler(event, context):
    """
    Main Lambda handler function
    """
    response = {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "status": "accepted",
            "message": "Request accepted and processing started"
        })
    }

    try:
        body = json.loads(event.get('body', '{}')) if isinstance(event.get('body'), str) else event.get('body', {})
        request_id = body.get('request_id')
        case_id = body.get('case_id')
        additional_data = body.get('additional_data')
        # Pipeline run context (see 20260918_case_pipeline_runs.sql). With a
        # run, only that run's newly uploaded files are converted — every
        # other document in data/ is either already anonymized or was removed
        # — and Extract/OCR2ANO read the rest of the case from the database.
        run_id = body.get('run_id')
        upload_files = body.get('upload_files')

        if not request_id:
            print("request_id missing")
        
        if not case_id:
            print("case_id missing")

        prefix = f"uploads/{request_id}/data/"
        print(f"Listing files from S3 path: {prefix}")

        s3_keys = list_s3_files(prefix)
        if run_id and upload_files is not None:
            wanted = {f"{prefix}{name}" for name in upload_files}
            s3_keys = [k for k in s3_keys if k in wanted]
            print(f"Run {run_id}: converting {len(s3_keys)} uploaded file(s)")

        if not s3_keys:
            print("No files found in data folder")


        converted_structure = []
        failed_files = []

        for s3_key in s3_keys:
            try:
                # .txt documents stay as they are; VMTB-EXTRACT-SUMMARIZE-V2
                # reads them itself. (This used to call .setdefault on
                # additional_data, which is a string, so the text was dropped.)
                if s3_key.lower().endswith('.txt'):
                    continue
                result = process_document(s3_key)
                if result:
                    converted_structure.append(result)
                else:
                    failed_files.append(s3_key)
            except Exception as e:
                print(f"Error processing {s3_key}: {str(e)}")
                failed_files.append(s3_key)

        if not converted_structure and not additional_data:
            print("All files failed to process")

        trigger_lambda_api(
            EXTRACT_LAMBDA_API,
            request_id,
            case_id,
            additional_data,
            converted_structure,
            run_id
        )

        trigger_anonymize_api(
            ANONYMIZE_LAMBDA_API,
            request_id
        )

    except Exception as e:
        print(f"Lambda execution error: {str(e)}")

    return response


DELETE_PREFIX = "DELETE_NNCMFAGSSS_22246_"
ANONYMIZED_PREFIX = "ANO_NNCMFAGSSS_22246_"


def list_s3_files(prefix: str) -> List[str]:
    """
    List the files under uploads/{request_id}/data/ that still need
    converting: direct children only, excluding soft-deleted files and
    already-anonymized final PDFs.

    Skipping ANO_ files is what keeps a re-run (Reports "Save" after a
    delete/upload) from rasterizing every finished document back into
    data/ANO_.../page_N.png, deleting the PDF, and relying on
    VMTB-OCR2ANO-V2 to merge it back minutes later — during that window the
    Reports tab listed the page files instead of the document, the merged
    PDF lost quality on every pass, and its version history was recorded
    under the prefixed name. Nested keys are page working files from a run
    still in progress, never inputs.
    """
    keys = []
    paginator = s3_client.get_paginator('list_objects_v2')

    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=prefix, Delimiter='/'):
        for obj in page.get('Contents', []):
            key = obj['Key']
            filename = key[len(prefix):]

            if not filename or '/' in filename:
                continue

            if filename.startswith(DELETE_PREFIX):
                print(f"Skipping deleted file: {key}")
                continue

            if filename.startswith(ANONYMIZED_PREFIX):
                print(f"Skipping already-anonymized document: {key}")
                continue

            keys.append(key)

    print(f"Found {len(keys)} files")
    return keys


def process_document(s3_key: str) -> Dict:
    """
    Process a single document from S3
    """
    response = s3_client.get_object(Bucket=BUCKET_NAME, Key=s3_key)
    file_content = response['Body'].read()

    parent_path, filename = s3_key.rsplit('/', 1)
    file_name, file_ext = os.path.splitext(filename)
    file_ext = file_ext.lower()

    output_folder = f"{parent_path}/{file_name}"

    image_formats = {'.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif'}
    doc_formats = {'.doc', '.docx', '.ppt', '.pptx', '.odt', '.rtf'}

    png_keys = []

    if file_ext == '.txt':
        try:
            text_content = file_content.decode('utf-8', errors='ignore')
            return {
                'original_key': s3_key,
                'text_content': text_content
            }
        except Exception as e:
            print(f"Error reading TXT file {s3_key}: {str(e)}")
            return None

    if file_ext in image_formats:
        png_keys = convert_image_to_png(file_content, output_folder)
    elif file_ext == '.pdf':
        png_keys = convert_pdf_to_png(file_content, output_folder)
    elif file_ext in doc_formats:
        png_keys = convert_docs_to_png(file_content, file_ext, output_folder)
    else:
        print(f"Unsupported file format: {file_ext}")
        return None

    if png_keys:
        s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
        return {
            'original_key': s3_key,
            'output_folder': output_folder,
            'images': png_keys
        }

    return None


def convert_image_to_png(file_content: bytes, output_folder: str) -> List[str]:
    """
    Convert image to PNG format and upload to S3
    """
    try:
        image = Image.open(io.BytesIO(file_content))

        if image.mode not in ('RGB', 'L'):
            image = image.convert('RGB')

        png_buffer = io.BytesIO()
        image.save(png_buffer, format='PNG')
        png_buffer.seek(0)

        output_key = f"{output_folder}/page_0.png"
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=output_key,
            Body=png_buffer.getvalue(),
            ContentType='image/png'
        )

        return [output_key]

    except Exception as e:
        print(f"Error converting image to PNG: {str(e)}")
        return []


def convert_pdf_to_png(file_content: bytes, output_folder: str) -> List[str]:
    """
    Convert PDF pages to PNG images and upload to S3
    """
    try:
        pdf_document = fitz.open(stream=file_content, filetype="pdf")
        png_keys = []

        for page_num in range(len(pdf_document)):
            page = pdf_document[page_num]
            mat = fitz.Matrix(2.0, 2.0)
            pix = page.get_pixmap(matrix=mat)
            img_data = pix.tobytes("png")

            output_key = f"{output_folder}/page_{page_num}.png"
            s3_client.put_object(
                Bucket=BUCKET_NAME,
                Key=output_key,
                Body=img_data,
                ContentType='image/png'
            )

            png_keys.append(output_key)

        pdf_document.close()
        return png_keys

    except Exception as e:
        print(f"Error converting PDF to PNG: {str(e)}")
        return []


def convert_docs_to_png(file_content: bytes, file_ext: str, output_folder: str) -> List[str]:
    """
    Convert DOC/PPT files to PDF using LibreOffice and then PDF to PNG
    """
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = os.path.join(tmpdir, f"input{file_ext}")
            pdf_path = os.path.join(tmpdir, "input.pdf")

            with open(input_path, "wb") as f:
                f.write(file_content)

            subprocess.run(
                [
                    "/usr/bin/soffice",
                    "--headless",
                    "--nologo",
                    "--nofirststartwizard",
                    "--nodefault",
                    "--norestore",
                    "-env:UserInstallation=file:///tmp/libreoffice-profile",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    tmpdir,
                    input_path
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60
            )

            if not os.path.exists(pdf_path):
                print("PDF conversion failed")
                return []

            with open(pdf_path, "rb") as pdf_file:
                return convert_pdf_to_png(pdf_file.read(), output_folder)

    except Exception as e:
        print(f"Error converting document to PNG: {str(e)}")
        return []


def trigger_lambda_api(api_url: str, request_id: str, case_id: str, additional_data: Dict, converted_structure: List[Dict], run_id: str = None) -> Dict:
    """
    Trigger downstream Lambda via API Gateway
    """
    try:
        payload = {
            'request_id': request_id,
            'case_id': case_id,
            'additional_data': additional_data,
            'run_id': run_id
        }

        response = requests.post(
            api_url,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=30
        )

        response.raise_for_status()

        return {
            'status_code': response.status_code,
            'response': response.json() if response.content else {}
        }

    except Exception as e:
        print(f"Error triggering {api_url}: {str(e)}")
        return {'error': str(e)}


def trigger_anonymize_api(api_url: str, request_id: str) -> Dict:
    """
    Trigger anonymize Lambda via API Gateway
    """
    try:
        payload = {
            'request_id': request_id
        }

        response = requests.post(
            api_url,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=30
        )

        response.raise_for_status()

        return {
            'status_code': response.status_code,
            'response': response.json() if response.content else {}
        }

    except Exception as e:
        print(f"Error triggering anonymize API {api_url}: {str(e)}")
        return {'error': str(e)}