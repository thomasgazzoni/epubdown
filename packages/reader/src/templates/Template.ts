import { render as renderTemplate } from "./MinimalTemplate";

export class Template {
  constructor(
    public id: string,
    public title: string,
    public body: string,
  ) {}

  async render(ctx: unknown): Promise<string> {
    return renderTemplate(this.body, ctx);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseTemplates(md: string): Template[] {
  const lines = md.split("\n");
  const templates: Template[] = [];
  let currentTitle = "";
  let currentBody: string[] = [];
  let foundFirstHeader = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (foundFirstHeader && currentTitle) {
        templates.push(
          new Template(
            slugify(currentTitle),
            currentTitle,
            currentBody.join("\n").trim(),
          ),
        );
      }

      currentTitle = line.substring(2).trim();
      currentBody = [];
      foundFirstHeader = true;
    } else if (foundFirstHeader) {
      currentBody.push(line);
    }
  }

  if (foundFirstHeader && currentTitle) {
    templates.push(
      new Template(
        slugify(currentTitle),
        currentTitle,
        currentBody.join("\n").trim(),
      ),
    );
  }

  return templates;
}

// Type aliases for DI
export type ReaderTemplates = {
  selection: Template[];
  global: Template[];
  multipleChapters: Template[];
};
export const ReaderTemplatesToken = Symbol("ReaderTemplates");
