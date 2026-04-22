FROM python:3.12-alpine

RUN pip install --no-cache-dir beautifulsoup4==4.14.3 html5lib==1.1

COPY scripts/validate.py /usr/local/bin/validate.py

WORKDIR /workdir

ENTRYPOINT ["python3", "/usr/local/bin/validate.py"]
