FROM public.ecr.aws/lambda/python:3.11

# Build toolchain for Pillow (unpinned in requirements.txt — if a PyPI release
# has no prebuilt wheel for this base image, pip falls back to compiling from
# source). Mirrors the identical block in the sibling VMTB-OCR2ANO-V2 and
# VMTB-EXTRACT-SUMMARIZE-V2 Dockerfiles.
RUN yum install -y \
    gcc \
    gcc-c++ \
    make \
    libjpeg-turbo-devel \
    zlib-devel \
    freetype-devel \
    lcms2-devel \
    openjpeg2-devel \
    libtiff-devel \
    libwebp-devel \
    tcl-devel \
    tk-devel && \
    yum clean all

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY redaction_core.py .
COPY lambda_function.py .

CMD ["lambda_function.lambda_handler"]
