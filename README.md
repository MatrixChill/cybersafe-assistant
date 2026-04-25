# CyberSafe Assistant Monorepo

This repository is bootstrapped as an npm workspace monorepo with:

- `packages/app`: React + Vite dashboard app
- `packages/api`: Express + TypeScript backend API
- `packages/extension`: Chrome Manifest V3 extension
- `packages/shared-types`: Shared TypeScript contracts

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run dashboard:

   ```bash
   npm run dev:app
   ```

3. Run API:

   ```bash
   npm run dev:api
   ```

4. Build all packages:

   ```bash
   npm run build
   ```

## API database setup (PostgreSQL + Prisma)

1. Copy `packages/api/.env.example` to `packages/api/.env` and adjust `DATABASE_URL`.
2. Create your PostgreSQL database (example: `cybersafe_assistant`).
3. Generate Prisma client:

   ```bash
   npm run prisma:generate -w api
   ```

4. Create tables in the database:

   ```bash
   npm run db:push -w api
   ```
