/**
 * End-to-end test for multimodal model auto-detection migration.
 *
 * Tests the full flow:
 *   1. ModelRegistry loads MiniMax-M3 with input: ["text"]
 *   2. models.json is patched to add input: ["text", "image"]
 *   3. migrateModelsConfig() detects and patches (new models case)
 *   4. registry.refresh() reloads the patched config
 *   5. Model now shows input: ["text", "image"] in getAll()
 *   6. Idempotency: second call to migrateModelsConfig() returns 0
 *
 * Run with: node tests/multimodal-model-detection.test.mjs
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Minimal test runner ──
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ── Setup: temp agent dir ──
const tempDir = mkdtempSync(join(tmpdir(), 'pi-test-migration-'));
process.env.PI_CODING_AGENT_DIR = tempDir;
console.log(`[setup] Temp agent dir: ${tempDir}`);

const MODELS_JSON_PATH = join(tempDir, 'models.json');
const INITIAL_MODELS_JSON = {
  providers: {
    minimax: {
      baseUrl: 'https://api.minimaxi.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        {
          id: 'MiniMax-M2.7',
          name: 'MiniMax-M2.7',
          input: ['text'],  // NOT multimodal — should stay as-is
        },
        {
          id: 'MiniMax-M3',
          name: 'MiniMax-M3',
          input: ['text'],  // IS multimodal — should be auto-detected
        },
      ],
    },
    dashscope: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        {
          id: 'qwen-vl-max',
          name: 'Qwen-VL Max',
          input: ['text', 'image'],  // Already multimodal — should stay as-is
        },
        {
          id: 'qwen-plus',
          name: 'Qwen Plus',
          input: ['text'],  // NOT multimodal — should stay as-is
        },
      ],
    },
  },
};

function writeModelsJson(config) {
  writeFileSync(MODELS_JSON_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function readModelsJson() {
  return JSON.parse(readFileSync(MODELS_JSON_PATH, 'utf-8'));
}

// Write initial config
writeModelsJson(INITIAL_MODELS_JSON);

// ── Test 1: ModelRegistry loads models with correct input ──
test('ModelRegistry loads MiniMax-M3 with input: ["text"] initially', async () => {
  const { ModelRegistry, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  // pi 1.x: the async runtime owns the catalog; the registry is a sync facade.
  const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));

  const minimaxM3 = registry.getAll().find(m => m.id === 'MiniMax-M3');
  assert(minimaxM3, 'MiniMax-M3 should be in the registry');
  assert(
    JSON.stringify(minimaxM3.input) === JSON.stringify(['text']),
    `Expected input: ["text"], got: ${JSON.stringify(minimaxM3.input)}`
  );

  // Verify M2.7 stays text-only
  const minimaxM27 = registry.getAll().find(m => m.id === 'MiniMax-M2.7');
  assert(minimaxM27, 'MiniMax-M2.7 should be in the registry');
  assert(
    JSON.stringify(minimaxM27.input) === JSON.stringify(['text']),
    `MiniMax-M2.7 should stay text-only, got: ${JSON.stringify(minimaxM27.input)}`
  );

  // Verify Qwen-VL Max stays multimodal
  const qwenVl = registry.getAll().find(m => m.id === 'qwen-vl-max');
  assert(
    qwenVl.input.includes('image'),
    `Qwen-VL Max should include image, got: ${JSON.stringify(qwenVl.input)}`
  );
});

// ── Test 2: migrateModelsConfig patches MiniMax-M3 ──
test('migrateModelsConfig patches MiniMax-M3 to include image', async () => {
  // Reset to initial state (MiniMax-M3 has input: ["text"])
  writeModelsJson(INITIAL_MODELS_JSON);

  const { migrateModelsConfig } = await import('../../../packages/sdk-wrapper/src/adapters/config.ts');

  // Run migration — should patch MiniMax-M3
  const patched = migrateModelsConfig();
  assert(patched === 1, `Expected 1 model patched, got ${patched}`);

  // Verify the file was written correctly
  const config = readModelsJson();
  const minimaxM3 = config.providers.minimax.models.find(m => m.id === 'MiniMax-M3');
  assert(
    JSON.stringify(minimaxM3.input) === JSON.stringify(['text', 'image']),
    `MiniMax-M3 should now have input: ["text", "image"], got: ${JSON.stringify(minimaxM3.input)}`
  );

  // Verify M2.7 was NOT touched
  const minimaxM27 = config.providers.minimax.models.find(m => m.id === 'MiniMax-M2.7');
  assert(
    JSON.stringify(minimaxM27.input) === JSON.stringify(['text']),
    `MiniMax-M2.7 should still be text-only, got: ${JSON.stringify(minimaxM27.input)}`
  );

  // Verify Qwen-VL Max was NOT changed
  const qwenVl = config.providers.dashscope.models.find(m => m.id === 'qwen-vl-max');
  assert(
    JSON.stringify(qwenVl.input) === JSON.stringify(['text', 'image']),
    `Qwen-VL Max should still be multimodal, got: ${JSON.stringify(qwenVl.input)}`
  );

  // Verify Qwen Plus stays text-only
  const qwenPlus = config.providers.dashscope.models.find(m => m.id === 'qwen-plus');
  assert(
    JSON.stringify(qwenPlus.input) === JSON.stringify(['text']),
    `Qwen Plus should stay text-only, got: ${JSON.stringify(qwenPlus.input)}`
  );
});

// ── Test 3: Idempotency — second call returns 0 ──
test('migrateModelsConfig is idempotent', async () => {
  const { migrateModelsConfig } = await import('../../../packages/sdk-wrapper/src/adapters/config.ts');

  const patched = migrateModelsConfig();
  assert(patched === 0, `Expected 0 models patched on second run, got ${patched}`);
});

// ── Test 4: registry.refresh() picks up patched config ──
test('registry.refresh() reloads patched MiniMax-M3 with image support', async () => {
  // At this point, models.json has MiniMax-M3 with input: ["text", "image"]
  // (patched by test 2). Let's create a registry and verify.
  const { ModelRegistry, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  // pi 1.x: the async runtime owns the catalog; the registry is a sync facade.
  const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));

  const minimaxM3 = registry.getAll().find(m => m.id === 'MiniMax-M3');
  assert(minimaxM3, 'MiniMax-M3 should be in the registry');
  assert(
    minimaxM3.input.includes('image'),
    `MiniMax-M3 should include image after refresh, got: ${JSON.stringify(minimaxM3.input)}`
  );
});

// ── Test 5: Simulate chat.ts flow — migrateModelsConfig() + registry.refresh() ──
test('chat.ts flow: migrate + refresh updates in-memory model', async () => {
  // Reset to initial state
  writeModelsJson(INITIAL_MODELS_JSON);

  const { ModelRegistry, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { migrateModelsConfig } = await import('../../../packages/sdk-wrapper/src/adapters/config.ts');

  // Simulate app startup: registry loaded BEFORE migration
  const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));

  // At this point, in-memory model has input: ["text"]
  const beforeModel = registry.getAll().find(m => m.id === 'MiniMax-M3');
  assert(
    !beforeModel.input.includes('image'),
    'Before migration, MiniMax-M3 should NOT have image support in memory'
  );

  // Simulate chat.ts flow: migrate + refresh (this is what our fix does)
  migrateModelsConfig();
  await registry.refresh();

  // After refresh, in-memory model should have input: ["text", "image"]
  const afterModel = registry.getAll().find(m => m.id === 'MiniMax-M3');
  assert(afterModel, 'MiniMax-M3 should still be in the registry after refresh');
  assert(
    afterModel.input.includes('image'),
    `After migrate+refresh, MiniMax-M3 should include image, got: ${JSON.stringify(afterModel.input)}`
  );

  // Verify M2.7 still doesn't have image (not multimodal)
  const minimaxM27 = registry.getAll().find(m => m.id === 'MiniMax-M2.7');
  assert(
    !minimaxM27.input.includes('image'),
    `MiniMax-M2.7 should NOT include image, got: ${JSON.stringify(minimaxM27.input)}`
  );
});

// ── Test 6: Previously patched file (already multimodal) → migrate returns 0, refresh works ──
test('Already-patched file: migrate returns 0, refresh still works', async () => {
  // This simulates the user's actual situation: models.json was manually patched.
  // models.json already has MiniMax-M3 with input: ["text", "image"]
  // (set by test 5's migrateModelsConfig)

  const { ModelRegistry, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { migrateModelsConfig } = await import('../../../packages/sdk-wrapper/src/adapters/config.ts');

  // Simulate app startup with already-patched config
  const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));

  // Migration returns 0 (nothing to patch) but we still call refresh()
  const patched = migrateModelsConfig();
  assert(patched === 0, `Expected 0 models patched (already done), got ${patched}`);
  await registry.refresh();  // This is the KEY: always refresh regardless of migration result

  const model = registry.getAll().find(m => m.id === 'MiniMax-M3');
  assert(model, 'MiniMax-M3 should be in the registry');
  assert(
    model.input.includes('image'),
    `MiniMax-M3 should include image after refresh, got: ${JSON.stringify(model.input)}`
  );
});

// ── Run ──
let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// Cleanup
try { rmSync(tempDir, { recursive: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
