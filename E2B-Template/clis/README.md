# CLIs

Install scripts and wrappers for binaries on the sandbox `PATH`.

## Rules

- Install at **template build** time.
- **No** real API keys in the image.
- CLIs that need keys: Worker proxy / fake token + base URL (see `documentation/tooling/general.md`).

## TODO

- [ ] List required CLIs  
- [ ] Add install script(s)  
- [ ] Wire into `../template.ts`  
