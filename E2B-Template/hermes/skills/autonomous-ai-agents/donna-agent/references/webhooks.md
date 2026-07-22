# Webhooks (Donna)

External webhooks can trigger agent runs when the webhook platform is enabled in config.

## Product note

Prefer product-supported messaging channels (e.g. Telegram) for user interaction. Only set up raw webhooks when the user explicitly needs an HTTP event intake.

## Runtime paths

Agent home and env may appear as `~/.hermes/` / `${HERMES_HOME}` in tooling. Do not present those names as a product brand to the user.
