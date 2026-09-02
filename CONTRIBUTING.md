# Contributing to ClawRouter

## Setup

```bash
git clone https://github.com/BlockRunAI/ClawRouter
cd ClawRouter
npm install
npm run build
```

## Development

```bash
npm run dev              # Watch mode
npm test                 # Unit tests (vitest)
npm run typecheck        # Type checking
npm run lint             # Linting
npm run format           # Format code
```

## Testing

```bash
npm test                           # Unit tests
npm run test:resilience:quick      # Error + lifecycle tests
npm run test:e2e:openclaw-collision  # OpenClaw plugin collision/migration gate (real openclaw CLI, isolated sandbox)
npm run test:docker:install        # Docker install test
npm run test:docker:edge-cases     # Edge case tests
npm run test:docker:integration    # Integration tests
```

## Code Standards

- TypeScript strict mode
- ESM modules only
- Format with Prettier, lint with ESLint
- All tests must pass before PR

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Run full test suite
4. Submit PR with clear description

## License

MIT
