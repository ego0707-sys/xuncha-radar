FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:render

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/radar_engine/src \
    PORT=10000
WORKDIR /app
COPY --from=frontend /app/dist/client ./dist/client
COPY radar_engine ./radar_engine
COPY render_app.py ./render_app.py
EXPOSE 10000
CMD ["python", "render_app.py"]
