# Minimalist Web Notepad

This is a Cloudflare Workers rewrite of Pere Orga's minimalist web notepad, an
open-source clone of the now-defunct notepad.cc: "a piece of paper in the cloud".

Open `/anything`, type, and the note autosaves. Opening `/` redirects to a random
short note name.

## Features

- No login, no database server, no build framework.
- Notes are stored in Cloudflare KV.
- `GET /note?raw` returns plain text.
- `curl` and `Wget` clients receive raw text by default.
- `POST /note` writes request body text, or the `text` field from
  `application/x-www-form-urlencoded` requests.
- Empty writes delete a note.
- Invalid or missing note names redirect to a random 5-character note.

## Deploy to Cloudflare Workers

Install dependencies:

```sh
npm install
```

Create a KV namespace:

```sh
npx wrangler kv namespace create NOTES
```

Put the returned namespace id into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "NOTES",
    "id": "your-kv-namespace-id"
  }
]
```

Run locally:

```sh
npm run dev
```

Deploy:

```sh
npm run deploy
```

## Configuration

`NOTE_MAX_BYTES` limits note size in bytes. The default in `wrangler.jsonc` is
`262144`.

`NOTE_TTL_SECONDS` controls automatic expiration. Set it to `0` to keep notes
until they are overwritten or deleted.

## Usage

Retrieve a note:

```sh
curl https://example.com/test
```

Save text:

```sh
curl https://example.com/test -d 'hello,

welcome to my pad!
'
```

Save a file:

```sh
cat /etc/hosts | curl https://example.com/hosts --data-binary @-
```

Delete a note:

```sh
curl https://example.com/test -d ''
```

## License

Copyright 2012 Pere Orga <pere@orga.cat>

Licensed under the Apache License, Version 2.0.
