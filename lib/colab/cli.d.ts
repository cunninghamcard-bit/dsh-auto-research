#!/usr/bin/env node
/**
 * Command-line bridge for `dsh-auto-research/colab` (`dsh-colab`).
 *
 * Subcommands:
 * - `health`: Query the remote Colab GPU server status and queue depth.
 * - `exec [--timeout <sec>] [--cold-l2-flush] [workspace] -- <cmd...>`: Sync `workspace` to Colab and run `<cmd...>` on the GPU queue.
 * - `bootstrap [--port 8765] [--tunnel cloudflared|ngrok|none]`: Print the 1-cell Colab Notebook setup code.
 */
export declare function runColabCli(argv: string[], env?: NodeJS.ProcessEnv, streams?: {
    stdout: {
        write: (chunk: string) => unknown;
    };
    stderr: {
        write: (chunk: string) => unknown;
    };
}): Promise<number>;
//# sourceMappingURL=cli.d.ts.map