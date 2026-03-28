FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV FUNCTION_TARGET=train_routing_model
ENV PORT=8080

CMD exec functions-framework --target=$FUNCTION_TARGET --port=$PORT
