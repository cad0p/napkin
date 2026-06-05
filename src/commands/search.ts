import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
} from "../utils/output.js";

interface SearchOpts extends OutputOptions {
  vault?: string;
  query?: string;
  path?: string;
  limit?: string;
  page?: string;
  total?: boolean;
  contextLines?: string;
  snippets?: boolean;
  score?: boolean;
}

export async function search(opts: SearchOpts) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!opts.query) {
    error("No query specified. Use --query <text>");
    process.exit(EXIT_USER_ERROR);
  }

  const searchOpts = {
    path: opts.path,
    limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
    contextLines: opts.contextLines
      ? Number.parseInt(opts.contextLines, 10)
      : undefined,
    snippets: opts.snippets,
  };

  const page = opts.page ? Number.parseInt(opts.page, 10) : undefined;
  const hasPage = page !== undefined;

  if (hasPage) {
    const paginated = n.searchPaginated(opts.query, { ...searchOpts, page });
    output(opts, {
      json: () => {
        if (opts.total) return { total: paginated.totalResults };
        const mapResult = (r: (typeof paginated.results)[0]) => {
          const { score: _score, snippets, ...rest } = r;
          const out: Record<string, unknown> = { ...rest };
          if (opts.score) out.score = r.score;
          if (opts.snippets !== false) out.snippets = snippets;
          return out;
        };
        return {
          results: paginated.results.map(mapResult),
          totalPages: paginated.totalPages,
          currentPage: paginated.currentPage,
          totalResults: paginated.totalResults,
        };
      },
      human: () => {
        if (opts.total) {
          console.log(paginated.totalResults);
          return;
        }
        for (const r of paginated.results) {
          console.log(
            `${bold(r.file)} ${dim(`(${opts.score ? `score: ${r.score}, ` : ""}links: ${r.links}, modified: ${r.modified})`)}`,
          );
          for (const s of r.snippets) {
            console.log(`  ${dim(`${s.line}:`)} ${s.text}`);
          }
        }
        if (paginated.currentPage < paginated.totalPages) {
          console.log("");
          console.log(
            dim(
              `[Page ${paginated.currentPage} of ${paginated.totalPages}. Use --page ${paginated.currentPage + 1} to continue.]`,
            ),
          );
        }
      },
    });
    return;
  }

  const top = n.search(opts.query, searchOpts);

  output(opts, {
    json: () => {
      if (opts.total) return { total: top.length };
      const mapResult = (r: (typeof top)[0]) => {
        const { score: _score, snippets, ...rest } = r;
        const out: Record<string, unknown> = { ...rest };
        if (opts.score) out.score = r.score;
        if (opts.snippets !== false) out.snippets = snippets;
        return out;
      };
      return { results: top.map(mapResult) };
    },
    human: () => {
      if (opts.total) {
        console.log(top.length);
        return;
      }
      for (const r of top) {
        console.log(
          `${bold(r.file)} ${dim(`(${opts.score ? `score: ${r.score}, ` : ""}links: ${r.links}, modified: ${r.modified})`)}`,
        );
        for (const s of r.snippets) {
          console.log(`  ${dim(`${s.line}:`)} ${s.text}`);
        }
      }
      console.log("");
      console.log(
        dim(
          "HINT: Use napkin read <file> to open a full file. Use napkin outline --file <file> to see its structure.",
        ),
      );
    },
  });
}
