This directory is intentionally packaged into the app as `defaults/`.

Place a local file named `default-provider.json` here when you want a build to ship with a preconfigured provider.

Expected shape:

```json
{
  "mode": "minimax_newapi",
  "values": {
    "apiKey": "sk-...",
    "model": "gpt-5.4"
  }
}
```

This file is ignored by Git on purpose.
