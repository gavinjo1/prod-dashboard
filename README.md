# ddashboard

## Menjalankan dengan Docker

```bash
cp .env.example .env
```

Isi `POSTGRES_PASSWORD` dan `SESSION_SECRET` di `.env`, lalu:

```bash
docker compose up -d --build
```

Buka http://localhost:3000 dan daftarkan akun pertama.

Melihat log:

```bash
docker compose logs -f app
```

Menghentikan:

```bash
docker compose down
```

## Menjalankan tanpa Docker

Butuh Node.js 22 dan PostgreSQL.

```bash
npm install
cp .env.example .env
```

Isi `PGUSER`, `PGPASSWORD` dan `SESSION_SECRET` di `.env`, lalu:

```bash
npm run setup
npm start
```

Buka http://localhost:3000 dan daftarkan akun pertama.

## Memperbarui

```bash
git pull
docker compose up -d --build
```
