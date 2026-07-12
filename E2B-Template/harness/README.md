# Harness

Small HTTP (or similar) entrypoint the **Worker** calls:

```
Worker → POST sandbox harness → Hermes turn → reply JSON
```

## Responsibilities

- Accept capability-authenticated requests from Worker  
- Run one user turn on Hermes in this sandbox  
- Return text/media descriptors (Worker sends to Telegram/etc.)  
- Never require channel tokens inside the sandbox  

## Warm start

When ready, `template.ts` `setStartCmd` should start this harness and wait for its port so create is fast.

## TODO

- [ ] Implement server  
- [ ] Wire `setStartCmd` + port wait in `../template.ts`  
