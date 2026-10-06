This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## MCP server

Routiq exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io) server at `/api/mcp` so an LLM can read the whole dashboard, from the overview down to individual stops. See [docs/MCP.md](docs/MCP.md) for setup, client configuration and the security model.

Every API route requires a signed-in user of the right company (or the operator secret). See [docs/SECURITY.md](docs/SECURITY.md) for who can call what, and the Firestore-rules deploy step.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## FieldRoutes office scope

The FieldRoutes key (`FR_AUTH_KEY` / `FR_AUTH_TOKEN`) may be a **global** key covering several offices. A global key
returns every office unless told otherwise, so every FieldRoutes search sends `officeIDs` and every route/appointment
create sends `officeID`, taken from `FR_OFFICE_IDS`:

| `FR_OFFICE_IDS` | Effect |
|---|---|
| unset | `1` — NWA only (the default) |
| `1,2` | NWA and Central AR |
| `all` | no office filter |
