FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Cloud Run injects PORT (default 8080 locally). JITSI_PUBLIC_URL must be
# reachable from this container (default: production meet host).
ENV JITSI_PUBLIC_URL=https://server-vmtb-v2.3billionpairs.com \
    JITSI_PROBE_TIMEOUT_SECONDS=5

EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
