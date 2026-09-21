FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
# Un seul worker : l'état des sessions est conservé en mémoire.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
