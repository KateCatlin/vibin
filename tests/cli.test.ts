import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli.js';

describe('createProgram', () => {
  it('registers the vibin subcommands', () => {
    const program = createProgram({ VIBIN_MOCK_AI_RESPONSE: 'ok' });
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toEqual(expect.arrayContaining(['security', 'ui', 'users', 'check']));
  });
});
