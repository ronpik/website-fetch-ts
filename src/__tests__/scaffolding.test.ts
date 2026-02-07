import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scaffolding verification tests for Task 1.1.
 *
 * These tests validate that the project structure, configuration,
 * and build output are correct after initial scaffolding.
 */

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readJson(relativePath: string): Record<string, unknown> {
  const fullPath = join(PROJECT_ROOT, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Directory structure
// ---------------------------------------------------------------------------
describe("directory structure", () => {
  const expectedDirs = [
    "src/cli",
    "src/sdk",
    "src/crawler",
    "src/converter",
    "src/output",
    "src/fetcher",
    "src/llm",
    "src/bin",
  ];

  it.each(expectedDirs)(
    "should have the %s directory",
    (dir) => {
      const fullPath = join(PROJECT_ROOT, dir);
      expect(existsSync(fullPath), `${dir} should exist`).toBe(true);
      expect(statSync(fullPath).isDirectory(), `${dir} should be a directory`).toBe(true);
    },
  );

  it("should have the src/__tests__ directory", () => {
    const testsDir = join(PROJECT_ROOT, "src/__tests__");
    expect(existsSync(testsDir)).toBe(true);
    expect(statSync(testsDir).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Placeholder index.ts files
// ---------------------------------------------------------------------------
describe("placeholder source files", () => {
  const expectedPlaceholders = [
    "src/cli/index.ts",
    "src/sdk/index.ts",
    "src/crawler/index.ts",
    "src/converter/index.ts",
    "src/output/index.ts",
    "src/fetcher/index.ts",
    "src/llm/index.ts",
  ];

  it.each(expectedPlaceholders)(
    "should have placeholder file %s",
    (filePath) => {
      const fullPath = join(PROJECT_ROOT, filePath);
      expect(existsSync(fullPath), `${filePath} should exist`).toBe(true);
    },
  );

  it("should have src/types.ts placeholder", () => {
    expect(existsSync(join(PROJECT_ROOT, "src/types.ts"))).toBe(true);
  });

  it("should have src/bin/website-fetch.ts CLI entry point", () => {
    const binPath = join(PROJECT_ROOT, "src/bin/website-fetch.ts");
    expect(existsSync(binPath)).toBe(true);
    const content = readFileSync(binPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env node");
  });
});

// ---------------------------------------------------------------------------
// 3. Placeholder files can be imported (ESM)
// ---------------------------------------------------------------------------
describe("placeholder imports", () => {
  it("should import cli/index.ts without error", async () => {
    const mod = await import("../cli/index.js");
    expect(mod).toBeDefined();
  });

  it("should import sdk/index.ts without error", async () => {
    const mod = await import("../sdk/index.js");
    expect(mod).toBeDefined();
  });

  it("should import crawler/index.ts without error", async () => {
    const mod = await import("../crawler/index.js");
    expect(mod).toBeDefined();
  });

  it("should import converter/index.ts without error", async () => {
    const mod = await import("../converter/index.js");
    expect(mod).toBeDefined();
  });

  it("should import output/index.ts without error", async () => {
    const mod = await import("../output/index.js");
    expect(mod).toBeDefined();
  });

  it("should import fetcher/index.ts without error", async () => {
    const mod = await import("../fetcher/index.js");
    expect(mod).toBeDefined();
  });

  it("should import llm/index.ts without error", async () => {
    const mod = await import("../llm/index.js");
    expect(mod).toBeDefined();
  });

  it("should import types.ts without error", async () => {
    const mod = await import("../types.js");
    expect(mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. package.json validation
// ---------------------------------------------------------------------------
describe("package.json", () => {
  const pkg = readJson("package.json") as Record<string, unknown>;

  it("should have name set to website-fetch", () => {
    expect(pkg.name).toBe("website-fetch");
  });

  it("should use ESM modules (type: module)", () => {
    expect(pkg.type).toBe("module");
  });

  it("should have engines.node >= 18", () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines).toBeDefined();
    expect(engines.node).toBeDefined();
    expect(engines.node).toMatch(/18/);
  });

  describe("bin entry", () => {
    it("should have a bin entry for website-fetch", () => {
      const bin = pkg.bin as Record<string, string>;
      expect(bin).toBeDefined();
      expect(bin["website-fetch"]).toBe("./dist/bin/website-fetch.js");
    });
  });

  describe("exports map", () => {
    const expectedExports: Record<string, string> = {
      ".": "./dist/sdk/index.js",
      "./fetcher": "./dist/fetcher/index.js",
      "./converter": "./dist/converter/index.js",
      "./llm": "./dist/llm/index.js",
      "./crawler": "./dist/crawler/index.js",
      "./output": "./dist/output/index.js",
    };

    it("should have all required export entries", () => {
      const exports = pkg.exports as Record<string, string>;
      expect(exports).toBeDefined();
      for (const [key, value] of Object.entries(expectedExports)) {
        expect(exports[key], `exports["${key}"] should be "${value}"`).toBe(value);
      }
    });

    it("should have exactly 6 export entries", () => {
      const exports = pkg.exports as Record<string, string>;
      expect(Object.keys(exports)).toHaveLength(6);
    });
  });

  describe("required dependencies", () => {
    const requiredDeps = [
      "commander",
      "ai",
      "@ai-sdk/anthropic",
      "turndown",
      "@mozilla/readability",
      "jsdom",
      "robots-parser",
      "p-queue",
      "zod",
    ];

    const deps = pkg.dependencies as Record<string, string>;

    it.each(requiredDeps)(
      "should have dependency: %s",
      (dep) => {
        expect(deps, "dependencies should be defined").toBeDefined();
        expect(deps[dep], `dependency "${dep}" should be present`).toBeDefined();
      },
    );
  });

  describe("required devDependencies", () => {
    const requiredDevDeps = [
      "typescript",
      "vitest",
      "@types/turndown",
      "@types/jsdom",
      "eslint",
      "prettier",
    ];

    const devDeps = pkg.devDependencies as Record<string, string>;

    it.each(requiredDevDeps)(
      "should have devDependency: %s",
      (dep) => {
        expect(devDeps, "devDependencies should be defined").toBeDefined();
        expect(devDeps[dep], `devDependency "${dep}" should be present`).toBeDefined();
      },
    );
  });

  describe("scripts", () => {
    const scripts = (readJson("package.json") as Record<string, unknown>)
      .scripts as Record<string, string>;

    it("should have a build script", () => {
      expect(scripts.build).toBeDefined();
      expect(scripts.build).toBe("tsc");
    });

    it("should have a test script using vitest", () => {
      expect(scripts.test).toBeDefined();
      expect(scripts.test).toContain("vitest");
    });

    it("should have a lint script", () => {
      expect(scripts.lint).toBeDefined();
    });

    it("should have a type-check script", () => {
      expect(scripts["type-check"]).toBeDefined();
      expect(scripts["type-check"]).toContain("tsc");
    });
  });
});

// ---------------------------------------------------------------------------
// 5. tsconfig.json validation
// ---------------------------------------------------------------------------
describe("tsconfig.json", () => {
  const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;

  it("should have strict mode enabled", () => {
    expect(compilerOptions.strict).toBe(true);
  });

  it("should target ES2022", () => {
    expect(compilerOptions.target).toBe("ES2022");
  });

  it("should use Node16 module system", () => {
    expect(compilerOptions.module).toBe("Node16");
  });

  it("should use Node16 module resolution", () => {
    expect(compilerOptions.moduleResolution).toBe("Node16");
  });

  it("should output to dist directory", () => {
    expect(compilerOptions.outDir).toBe("./dist");
  });

  it("should have rootDir set to ./src", () => {
    expect(compilerOptions.rootDir).toBe("./src");
  });

  it("should enable declaration generation", () => {
    expect(compilerOptions.declaration).toBe(true);
  });

  it("should enable declaration maps", () => {
    expect(compilerOptions.declarationMap).toBe(true);
  });

  it("should enable source maps", () => {
    expect(compilerOptions.sourceMap).toBe(true);
  });

  it("should enable esModuleInterop", () => {
    expect(compilerOptions.esModuleInterop).toBe(true);
  });

  it("should include src/**/*", () => {
    const include = tsconfig.include as string[];
    expect(include).toBeDefined();
    expect(include).toContain("src/**/*");
  });
});

// ---------------------------------------------------------------------------
// 6. Build output verification
// ---------------------------------------------------------------------------
describe("build output (dist)", () => {
  it("should have dist directory", () => {
    const distPath = join(PROJECT_ROOT, "dist");
    expect(existsSync(distPath)).toBe(true);
  });

  const expectedDistFiles = [
    "dist/sdk/index.js",
    "dist/sdk/index.d.ts",
    "dist/fetcher/index.js",
    "dist/fetcher/index.d.ts",
    "dist/converter/index.js",
    "dist/converter/index.d.ts",
    "dist/llm/index.js",
    "dist/llm/index.d.ts",
    "dist/crawler/index.js",
    "dist/crawler/index.d.ts",
    "dist/output/index.js",
    "dist/output/index.d.ts",
    "dist/bin/website-fetch.js",
    "dist/types.js",
    "dist/types.d.ts",
  ];

  it.each(expectedDistFiles)(
    "should have build output file: %s",
    (filePath) => {
      const fullPath = join(PROJECT_ROOT, filePath);
      expect(existsSync(fullPath), `${filePath} should exist in build output`).toBe(true);
    },
  );

  describe("exports map files match build output", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const exports = pkg.exports as Record<string, string>;

    for (const [exportKey, exportPath] of Object.entries(exports)) {
      it(`exports["${exportKey}"] -> ${exportPath} should exist`, () => {
        const fullPath = join(PROJECT_ROOT, exportPath);
        expect(existsSync(fullPath), `${exportPath} should exist for export "${exportKey}"`).toBe(
          true,
        );
      });
    }

    it("bin entry should exist in dist", () => {
      const bin = (pkg.bin as Record<string, string>)["website-fetch"];
      const fullPath = join(PROJECT_ROOT, bin);
      expect(existsSync(fullPath), `${bin} should exist for bin entry`).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. .gitignore verification
// ---------------------------------------------------------------------------
describe(".gitignore", () => {
  it("should exist", () => {
    expect(existsSync(join(PROJECT_ROOT, ".gitignore"))).toBe(true);
  });

  it("should ignore node_modules", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".gitignore"), "utf-8");
    expect(content).toMatch(/node_modules/);
  });

  it("should ignore dist", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".gitignore"), "utf-8");
    expect(content).toMatch(/dist/);
  });
});

// ---------------------------------------------------------------------------
// 8. node_modules sanity check (dependencies installed)
// ---------------------------------------------------------------------------
describe("dependencies are installed", () => {
  it("should have node_modules directory", () => {
    expect(existsSync(join(PROJECT_ROOT, "node_modules"))).toBe(true);
  });

  const criticalPackages = [
    "commander",
    "ai",
    "turndown",
    "jsdom",
    "p-queue",
    "zod",
    "typescript",
    "vitest",
  ];

  it.each(criticalPackages)(
    "should have %s installed in node_modules",
    (pkg) => {
      const pkgPath = join(PROJECT_ROOT, "node_modules", pkg);
      expect(existsSync(pkgPath), `${pkg} should be installed`).toBe(true);
    },
  );
});
