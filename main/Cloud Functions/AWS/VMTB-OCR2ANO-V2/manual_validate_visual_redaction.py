"""
Standalone, manual validation script for the Phase 3 visual-redaction
coordinate pipeline. NOT part of any automated test suite, NOT invoked by
CI, and NOT shipped in the deployed Lambda image (the Dockerfile only COPYs
requirements.txt and lambda_function.py explicitly).

What this proves: that a detection's normalized bounding box, once handed to
normalized_bbox_to_pixels() and drawn with PIL's ImageDraw.rectangle(), lands
on the correct pixels of the ORIGINAL image — end to end, using the real
functions from lambda_function.py, not a reimplementation.

What this does NOT prove: that the vision model correctly identifies real
logos/signatures/QR codes/stamps in real documents. That requires a live
Bedrock call against real or realistic sample documents, which costs money,
needs credentials, and — as of writing — no real hospital sample documents
are available to test against. This script only validates the deterministic
math/drawing pipeline downstream of whatever the model returns.

Run with: python "main/Cloud Functions/AWS/VMTB-OCR2ANO-V2/manual_validate_visual_redaction.py"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from PIL import Image, ImageDraw
from lambda_function import normalized_bbox_to_pixels

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "_manual_validation_output.png")

IMAGE_WIDTH = 1200
IMAGE_HEIGHT = 1600
WHITE = (255, 255, 255)


def draw_fake_logo(draw):
    """A bordered rectangle standing in for a hospital logo, top-left area."""
    bbox = [80, 60, 340, 180]
    draw.rectangle(bbox, outline=(20, 20, 120), width=6, fill=(230, 230, 250))
    draw.text((100, 110), "FAKE HOSPITAL LOGO", fill=(20, 20, 120))
    return "hospital_logo", bbox


def draw_fake_qr_code(draw):
    """A checkerboard block standing in for a QR code, top-right corner."""
    x0, y0 = 950, 60
    cell = 12
    cells_per_side = 10
    for row in range(cells_per_side):
        for col in range(cells_per_side):
            if (row + col) % 2 == 0:
                cx0 = x0 + col * cell
                cy0 = y0 + row * cell
                draw.rectangle([cx0, cy0, cx0 + cell, cy0 + cell], fill=(0, 0, 0))
    bbox = [x0, y0, x0 + cells_per_side * cell, y0 + cells_per_side * cell]
    return "qr_code", bbox


def draw_fake_signature(draw):
    """A scribble of connected line segments standing in for a signature."""
    points = [(150, 1400), (220, 1350), (280, 1420), (340, 1360), (400, 1410), (460, 1370)]
    draw.line(points, fill=(10, 10, 10), width=4)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    padding = 10
    bbox = [min(xs) - padding, min(ys) - padding, max(xs) + padding, max(ys) + padding]
    return "signature", bbox


def pixel_bbox_to_normalized(pixel_bbox, image_width, image_height):
    x1, y1, x2, y2 = pixel_bbox
    return [x1 / image_width, y1 / image_height, x2 / image_width, y2 / image_height]


def sample_is_white(image, x, y):
    return image.getpixel((x, y)) == WHITE


def main():
    image = Image.new("RGB", (IMAGE_WIDTH, IMAGE_HEIGHT), WHITE)
    draw = ImageDraw.Draw(image)

    shapes = [
        draw_fake_logo(draw),
        draw_fake_qr_code(draw),
        draw_fake_signature(draw),
    ]

    # Snapshot a pixel clearly outside every shape, to prove untouched areas stay untouched.
    outside_point = (600, 800)
    assert sample_is_white(image, *outside_point), "sanity check: background should start white"

    print(f"Canvas: {IMAGE_WIDTH}x{IMAGE_HEIGHT}")
    print(f"Drew {len(shapes)} synthetic 'fake PII' shapes.\n")

    all_passed = True

    for category, known_pixel_bbox in shapes:
        # Simulate what a "perfect" model response would contain: normalized
        # coordinates derived from the exact pixel box we just drew.
        bbox_normalized = pixel_bbox_to_normalized(known_pixel_bbox, IMAGE_WIDTH, IMAGE_HEIGHT)

        # Run it through the REAL production function, not a reimplementation.
        recovered_pixel_bbox = normalized_bbox_to_pixels(bbox_normalized, IMAGE_WIDTH, IMAGE_HEIGHT)

        # Redact using the same primitive the Lambda uses.
        draw.rectangle(recovered_pixel_bbox, fill="white")

        # Verify: a handful of interior sample points are now solid white.
        x1, y1, x2, y2 = recovered_pixel_bbox
        interior_points = [
            (x1 + (x2 - x1) // 4, y1 + (y2 - y1) // 2),
            (x1 + (x2 - x1) // 2, y1 + (y2 - y1) // 2),
            (x1 + 3 * (x2 - x1) // 4, y1 + (y2 - y1) // 2),
        ]
        interior_ok = all(sample_is_white(image, px, py) for px, py in interior_points)

        # Verify the recovered box is within a tolerance of the original
        # (rounding from normalization/de-normalization can shift by ~1px).
        tolerance = 2
        close_enough = all(
            abs(a - b) <= tolerance for a, b in zip(known_pixel_bbox, recovered_pixel_bbox)
        )

        status = "PASS" if (interior_ok and close_enough) else "FAIL"
        all_passed = all_passed and (interior_ok and close_enough)
        print(f"[{status}] {category}: known={known_pixel_bbox} recovered={recovered_pixel_bbox} "
              f"interior_white={interior_ok} within_tolerance={close_enough}")

    # Confirm the untouched background point is still white (nothing over-redacted).
    outside_still_white = sample_is_white(image, *outside_point)
    print(f"\n[{'PASS' if outside_still_white else 'FAIL'}] untouched background point {outside_point} "
          f"still white: {outside_still_white}")
    all_passed = all_passed and outside_still_white

    image.save(OUTPUT_PATH)
    print(f"\nSaved visual output to: {OUTPUT_PATH}")
    print("\nOverall:", "ALL CHECKS PASSED" if all_passed else "SOME CHECKS FAILED")
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
