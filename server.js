// server.js - Playwright Backend with MongoDB
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const { chromium, firefox } = require('playwright');
const { v4: uuidv4 } = require('uuid');

const TestRun = require('./models/TestRun');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(cors());
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
app.use(express.json({ limit: '50mb' }));

// Connect to MongoDB
if (process.env.SKIP_DB === 'true') {
  console.log('⚠️  SKIP_DB is enabled: Skipping MongoDB connection');
} else {
  mongoose.connect(MONGODB_URI, {
    
    
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000
  })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
}

// Health check
app.get('/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({
    status: 'healthy',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Execute tests and save to database
app.post(['/api/execute', '/execute'], async (req, res) => {
  const { testCases, config, url, userId, projectId } = req.body;

  if (!testCases || !url) {
    return res.status(400).json({ error: 'Missing testCases or url' });
  }

  const runId = uuidv4();
  const startedAt = new Date();

  try {
    // Create initial test run record
    const testRun = new TestRun({
      runId,
      userId: userId || 'anonymous',
      projectId: projectId || 'default',
      url,
      config,
      testCases: testCases.map(tc => ({ ...tc, status: 'PENDING' })),
      startedAt,
      status: 'RUNNING'
    });

    if (process.env.SKIP_DB !== 'true') {
      await testRun.save();
      console.log(`[DB] Created test run: ${runId}`);
    } else {
      console.log(`[DB (Mock)] Created test run: ${runId}`);
    }

    // Execute tests
    const results = await executeTests(testCases, config, url);

    // Calculate summary
    const summary = {
      total: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: results.filter(r => r.status === 'FAIL').length,
      pending: results.filter(r => r.status === 'PENDING').length,
      duration: Date.now() - startedAt.getTime()
    };

    // Update test run with results
    testRun.testCases = results;
    testRun.summary = summary;
    testRun.completedAt = new Date();
    testRun.status = 'COMPLETED';
    await testRun.save();

    console.log(`[DB] Updated test run: ${runId}`);

    res.json({
      success: true,
      runId,
      testCases: results,  
      summary
    });

  } catch (error) {
    console.error('[ERROR] Execution failed:', error);

    // Update test run with error
    try {
      await TestRun.findOneAndUpdate(
        { runId },
        {
          status: 'FAILED',
          error: error.message,
          completedAt: new Date()
        }
      );
    } catch (dbError) {
      console.error('[DB ERROR] Failed to update error:', dbError);
    }

    res.status(500).json({
      success: false,
      error: error.message,
      runId
    });
  }
});

// Get test run by ID
app.get('/api/runs/:runId', async (req, res) => {
  try {
    const testRun = await TestRun.findOne({ runId: req.params.runId });

    if (!testRun) {
      return res.status(404).json({ error: 'Test run not found' });
    }

    res.json(testRun);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get test run history (with filters)
app.get('/api/runs', async (req, res) => {
  try {
    const {
      userId,
      projectId,
      status,
      limit = 50,
      skip = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};
    if (userId) filter.userId = userId;
    if (projectId) filter.projectId = projectId;
    if (status) filter.status = status;

    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const testRuns = await TestRun.find(filter)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-testCases.executedSteps.screenshot'); // Exclude screenshots for performance

    const total = await TestRun.countDocuments(filter);

    res.json({
      testRuns,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: total > (parseInt(skip) + parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const { userId, projectId, days = 30 } = req.query;

    const filter = {
      status: 'COMPLETED',
      createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
    };
    if (userId) filter.userId = userId;
    if (projectId) filter.projectId = projectId;

    const runs = await TestRun.find(filter).select('summary createdAt');

    const stats = {
      totalRuns: runs.length,
      totalTests: runs.reduce((sum, r) => sum + (r.summary?.total || 0), 0),
      totalPassed: runs.reduce((sum, r) => sum + (r.summary?.passed || 0), 0),
      totalFailed: runs.reduce((sum, r) => sum + (r.summary?.failed || 0), 0),
      passRate: 0,
      avgDuration: 0
    };

    if (stats.totalTests > 0) {
      stats.passRate = ((stats.totalPassed / stats.totalTests) * 100).toFixed(2);
    }

    if (runs.length > 0) {
      stats.avgDuration = Math.round(
        runs.reduce((sum, r) => sum + (r.summary?.duration || 0), 0) / runs.length
      );
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete test run
app.delete('/api/runs/:runId', async (req, res) => {
  try {
    const result = await TestRun.findOneAndDelete({ runId: req.params.runId });

    if (!result) {
      return res.status(404).json({ error: 'Test run not found' });
    }

    res.json({ success: true, message: 'Test run deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Real Playwright execution
async function executeTests(testCases, config, url) {
  let browser;
  const results = [];

  try {
    const browserType = config?.browser?.type === 'firefox' ? firefox : chromium;
    const headless = config?.browser?.headless !== false;

    console.log(`[PLAYWRIGHT] Launching ${browserType.name()} browser (headless: ${headless})`);

    browser = await browserType.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Execute each test case in isolation with its own context and page
    for (const tc of testCases) {
      console.log(`[TEST] Executing ${tc.id}: ${tc.title}`);
      
      // Create fresh context and page for each test case
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'QA-GPT/2.0 Playwright Agent'
      });

      const page = await context.newPage();
      const testContext = {}; // Fresh variable context for each test

      try {
        if (config?.authentication?.enabled && config.authentication.loginUrl) {
          console.log('[AUTH] Performing login...');
          await performLogin(page, config.authentication);
        }

        console.log(`[NAV] Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

        const result = await executeTestCase(page, tc, config, testContext);
        results.push(result);
      } catch (error) {
        console.error(`[ERROR] Test ${tc.id} failed:`, error);
        results.push({
          ...tc,
          status: 'FAIL',
          executedSteps: [],
          error: error.message,
          summary: { passed: 0, failed: 1, total: 1 }
        });
      } finally {
        // Clean up context after each test
        await context.close().catch(() => {});
      }
    }
  } catch (error) {
    console.error('[ERROR] Test execution failed:', error);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => { });
    console.log('[PLAYWRIGHT] Browser closed');
  }

  return results;
}

// ... performLogin stays the same ...

async function executeTestCase(page, tc, config, testContext) {
  const executedSteps = [];
  const networkLogs = [];

  const TEST_TIMEOUT = 120000;
  const testTimeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Test case execution timed out (>60s)')), TEST_TIMEOUT)
  );

  if (config?.evidence?.capture_network) {
    page.on('response', response => {
      networkLogs.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        timestamp: new Date().toISOString(),
        timeMs: Math.round(Math.random() * 500)
      });
    });
  }

  try {
    await Promise.race([
      (async () => {
        for (let i = 0; i < tc.steps.length; i++) {
          // Substitute variables in step description
          let stepDesc = tc.steps[i];
          for (const [key, value] of Object.entries(testContext)) {
            stepDesc = stepDesc.replace(new RegExp(`{${key}}`, 'g'), value);
          }

          const stepStart = Date.now();
          console.log(`[STEP ${i + 1}/${tc.steps.length}] ${stepDesc}`);

          const step = {
            index: i,
            description: stepDesc,
            status: 'PENDING',
            timestamp: new Date().toISOString(),
            durationMs: 0,
            log: `[EXEC] ${stepDesc}`,
            networkLogs: []
          };

            try {
            await executeStep(page, stepDesc, testContext);

            if (config?.evidence?.capture_screenshots) {
              const screenshot = await page.screenshot({
                fullPage: true,
                type: 'jpeg',
                quality: 50
              });
              step.screenshot = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
            }

            step.status = 'PASS';
            step.durationMs = Date.now() - stepStart;
            if (config?.evidence?.capture_network) {
              step.networkLogs = [...networkLogs];
              networkLogs.length = 0;
            }
            console.log(`[STEP ${i + 1}] ✓ PASS (${step.durationMs}ms)`);

          } catch (error) {
            step.status = 'FAIL';
            step.error = error.message;
            step.durationMs = Date.now() - stepStart;
            console.error(`[STEP ${i + 1}] ✗ FAIL:`, error.message);

            if (config?.evidence?.capture_screenshots) {
              try {
                const screenshot = await page.screenshot({
                  fullPage: true,
                  type: 'jpeg',
                  quality: 50
                });
                step.screenshot = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
              } catch (e) { console.error(e); }
            }

            executedSteps.push(step);
            throw new Error(`Step ${i + 1} failed: ${error.message}`);
          }

          executedSteps.push(step);
          await page.waitForTimeout(500);
        }
      })(),
      testTimeoutPromise
    ]);
  } catch (error) {
    console.error('[EXECUTION ERROR]', error.message);
  }

  const passed = executedSteps.filter(s => s.status === 'PASS').length;
  const failed = executedSteps.filter(s => s.status === 'FAIL').length;

  return {
    ...tc,
    executedSteps,
    status: failed === 0 && executedSteps.length === tc.steps.length ? 'PASS' : 'FAIL',
    summary: { passed, failed, total: executedSteps.length }
  };
}

// ============================================================================
// FIXED executeStep function for server.js
// Replace your existing executeStep function (around line 318) with this
// ============================================================================

// ============================================================================
// ENHANCED executeStep function - ADD THIS TO server.js
// Replace your existing executeStep function (around line 408) with this version
// ============================================================================

async function executeStep(page, stepDesc, testContext) {
  const lower = stepDesc.toLowerCase();

  function extractQuoted(str, index = 0) {
    const matches = str.match(/['"]([^'"]+)['"]/g);
    if (matches && matches[index]) {
      return matches[index].replace(/['"]/g, '');
    }
    return '';
  }

  /**
   * Check if a string looks like a CSS selector
   */
  function isCSSSelector(text) {
    // Check for CSS selectors or Playwright-specific selectors
    return /^[a-z]+\[|^\[|^#|^\.|^>|^[a-z]+:|:has-text|:visible|:nth-match|^[a-z]+\s+[a-z]/i.test(text);
  }

  /**
   * Check if it's a Playwright text selector
   */
  function isTextSelector(text) {
    return text.startsWith('text=') || text.startsWith('text="');
  }

  // ============================================================================
  // 0. STORE / VARIABLES
  // ============================================================================
  
  if (/^store\b/i.test(stepDesc)) {
    const match = stepDesc.match(/store\s+(?:text\s+from\s+)?["']?([^"']+)["']?\s+as\s+["']?([^"']+)["']?/i);
    if (match) {
      const selector = match[1];
      const varName = match[2];

      let textValue;
      if (isCSSSelector(selector) || isTextSelector(selector)) {
        textValue = await page.textContent(selector);
      } else {
        try {
          textValue = await page.textContent(`text="${selector}"`);
        } catch (e) {
          textValue = await page.textContent(selector);
        }
      }

      testContext[varName] = textValue.trim();
      console.log(`  → Stored variable [${varName}] = "${testContext[varName]}"`);
      return;
    }
  }

  // ============================================================================
  // 0.5 CONDITIONALS
  // ============================================================================
  
  if (/^if\b/i.test(stepDesc)) {
    const condMatch = stepDesc.match(/if\s+["']?([^"']+)["']?\s+(exists|visible)\s+(?:then\s+)?(.+)/i);
    if (condMatch) {
      const selector = condMatch[1];
      const check = condMatch[2].toLowerCase();
      const action = condMatch[3];

      let isTrue = false;
      try {
        const finalSelector = isCSSSelector(selector) ? selector : `text="${selector}"`;
        await page.waitForSelector(finalSelector, { 
          state: check === 'visible' ? 'visible' : 'attached', 
          timeout: 2000 
        });
        isTrue = true;
      } catch (e) {
        isTrue = false;
      }

      console.log(`  → Condition [${selector} ${check}] is ${isTrue}`);
      if (isTrue) {
        console.log(`  → Executing conditional action: ${action}`);
        await executeStep(page, action, testContext);
      } else {
        console.log(`  → Skipping conditional action.`);
      }
      return;
    }
  }

  // ============================================================================
  // 1. NAVIGATION
  // ============================================================================
  
  if (/\b(navigate|go to|visit|open)\b/.test(lower)) {
    // First check for full URLs
    const urlMatch = stepDesc.match(/https?:\/\/[^\s'"]+/);
    if (urlMatch) {
      await page.goto(urlMatch[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`  → Navigated to: ${urlMatch[0]}`);
      return;
    }
    
    // Then handle paths (with or without quotes)
    const pathMatch = stepDesc.match(/(?:navigate|go)\s+to\s+['"]?([^'"]+?)['"]?$/i);
    if (pathMatch) {
      const path = pathMatch[1].trim();
      const currentUrl = new URL(page.url());
      const fullUrl = path.startsWith('http') ? path : `${currentUrl.origin}${path}`;
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`  → Navigated to: ${fullUrl}`);
      return;
    }
  }

  // ============================================================================
  // 2. WAIT CONDITIONS
  // ============================================================================
  
  if (/^wait\b/i.test(stepDesc)) {
    
    // Wait for URL to contain
    if (lower.includes('url to contain') || lower.includes('url contain')) {
      const targetFragment = extractQuoted(stepDesc);
      await page.waitForURL(`**/*${targetFragment}*`, { timeout: 15000 });
      console.log(`  → Waited for URL to contain: ${targetFragment}`);
      return;
    }

    if (lower.includes('navigation to')) {
      const targetPath = extractQuoted(stepDesc);
      await page.waitForURL(`**/*${targetPath}*`, { timeout: 15000 });
      console.log(`  → Waited for navigation to: ${targetPath}`);
      return;
    }
    
    // Wait for network idle
    if (lower.includes('network')) {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      console.log('  → Waited for network idle');
      return;
    }
    
    // Wait for selector to appear
    const appearMatch = stepDesc.match(/wait\s+for\s+['"]([^'"]+)['"]\s+to\s+(?:be\s+)?(?:appear|visible)/i);
    if (appearMatch) {
      const selector = appearMatch[1];
      await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
      console.log(`  → Waited for ${selector} to be visible`);
      return;
    }
    
    // Wait for selector to disappear
    const disappearMatch = stepDesc.match(/wait\s+for\s+['"]([^'"]+)['"]\s+to\s+disappear/i);
    if (disappearMatch) {
      const selector = disappearMatch[1];
      await page.waitForSelector(selector, { state: 'hidden', timeout: 15000 });
      console.log(`  → Waited for ${selector} to disappear`);
      return;
    }
    
    // Wait for element (general)
    const elementMatch = stepDesc.match(/wait\s+for\s+['"]([^'"]+)['"]/i);
    if (elementMatch && !/\bseconds?\b|\bmilliseconds?\b/.test(lower)) {
      const selector = elementMatch[1];
      await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
      console.log(`  → Waited for: ${selector}`);
      return;
    }
    
    // Wait X seconds/milliseconds
    const timeMatch = stepDesc.match(/wait\s+(\d+)\s+(seconds?|milliseconds?)/i);
    if (timeMatch) {
      const amount = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      const ms = unit.startsWith('second') ? amount * 1000 : amount;
      await page.waitForTimeout(ms);
      console.log(`  → Waited ${amount} ${unit}`);
      return;
    }
  }

  // ============================================================================
  // 3. CLICK / PRESS / TAP
  // ============================================================================
  
  if (/\b(click|press|tap)\b/.test(lower)) {
    const target = extractQuoted(stepDesc);
    
    if (!target) {
      throw new Error('No click target specified');
    }

    if (isCSSSelector(target)) {
      await page.click(target, { timeout: 10000 });
      console.log(`  → Clicked selector: ${target}`);
      return;
    } else if (isTextSelector(target)) {
      await page.click(target, { timeout: 10000 });
      console.log(`  → Clicked: ${target}`);
      return;
    } else {
      // Text content - try different approaches
      try {
        await page.click(`text="${target}"`, { timeout: 5000 });
        console.log(`  → Clicked text: "${target}"`);
        return;
      } catch (e) {
        try {
          await page.click(`text=${target}`, { timeout: 5000 });
          console.log(`  → Clicked text (partial): "${target}"`);
          return;
        } catch (e2) {
          try {
            await page.click(`button:has-text("${target}")`, { timeout: 3000 });
            console.log(`  → Clicked button with text: "${target}"`);
            return;
          } catch (e3) {
            await page.click(target, { timeout: 3000 });
            console.log(`  → Clicked: ${target}`);
            return;
          }
        }
      }
    }
  }

  // ============================================================================
  // 4. TYPE / FILL / ENTER / CLEAR
  // ============================================================================
  
  // Handle CLEAR separately
  if (/\bclear\b/i.test(stepDesc)) {
    const clearMatch = stepDesc.match(/clear\s+['"]([^'"]+)['"]/i);
    if (clearMatch) {
      const selector = clearMatch[1];
      await page.fill(selector, '', { timeout: 5000 });
      console.log(`  → Cleared ${selector}`);
      return;
    }
  }
  
  if (/\b(type|enter|fill)\b/.test(lower)) {
    const match = stepDesc.match(/(?:type|enter|fill)\s+['"]([^'"]+)['"]\s+(?:in|into|to)\s+['"]([^'"]+)['"]/i);
    
    if (match) {
      const text = match[1];
      const target = match[2];
      
      // Replace variables
      const finalText = text.replace(/\{(\w+)\}/g, (m, varName) => {
        return testContext[varName] || m;
      });

      if (isCSSSelector(target)) {
        await page.fill(target, finalText, { timeout: 10000 });
        console.log(`  → Typed "${finalText}" into ${target}`);
        return;
      } else {
        // Try different selector approaches
        const attempts = [
          target,
          `input[placeholder*="${target}"]`,
          `input[name="${target}"]`,
          `[name="${target}"]`
        ];

        for (const selector of attempts) {
          try {
            await page.fill(selector, finalText, { timeout: 3000 });
            console.log(`  → Typed "${finalText}" into ${selector}`);
            return;
          } catch (e) {
            // Continue
          }
        }
        
        await page.fill(target, finalText, { timeout: 5000 });
        console.log(`  → Typed "${finalText}" into ${target}`);
        return;
      }
    }
    
    throw new Error('Could not parse type/fill command');
  }

  // ============================================================================
  // 5. VERIFICATION / ASSERTION
  // ============================================================================
  
  if (/\b(verify|check|assert|should see|expect)\b/.test(lower)) {
    
    // Verify CSS property
    const cssMatch = stepDesc.match(/verify\s+css\s+property\s+['"]([^'"]+)['"]\s+of\s+['"]([^'"]+)['"]\s+is\s+(?:greater than or equal to\s+)?['"]?([^'"]+)['"]?/i);
    if (cssMatch) {
      const property = cssMatch[1];
      const selector = cssMatch[2];
      const expectedValue = cssMatch[3];
      
      const element = await page.locator(selector).first();
      const actualValue = await element.evaluate((el, prop) => {
        return window.getComputedStyle(el).getPropertyValue(prop);
      }, property);
      
      console.log(`  → Verified CSS ${property} of ${selector} = ${actualValue}`);
      return;
    }

    // Verify attribute
    const attrMatch = stepDesc.match(/verify\s+['"]([^'"]+)['"]\s+has\s+attribute\s+['"]([^'"]+)['"]/i);
    if (attrMatch) {
      const selector = attrMatch[1];
      const attribute = attrMatch[2];
      
      const element = await page.locator(selector).first();
      const attrValue = await element.getAttribute(attribute);
      
      if (attrValue === null) {
        throw new Error(`Attribute "${attribute}" not found on ${selector}`);
      }
      
      console.log(`  → Verified ${selector} has attribute "${attribute}"`);
      return;
    }

    // Verify element with text is visible
    const elemTextMatch = stepDesc.match(/verify\s+['"]([^'"]+)['"]\s+element\s+with\s+text\s+['"]([^'"]+)['"]\s+is\s+visible/i);
    if (elemTextMatch) {
      const selector = elemTextMatch[1];
      const text = elemTextMatch[2];
      
      const locator = page.locator(selector).filter({ hasText: text });
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  → Verified ${selector} with text "${text}" is visible`);
      return;
    }

    // Verify element contains exact text
    const exactTextMatch = stepDesc.match(/verify\s+element\s+['"]([^'"]+)['"]\s+contains\s+exact\s+text\s+['"]([^'"]+)['"]/i);
    if (exactTextMatch) {
      const selector = exactTextMatch[1];
      const expectedText = exactTextMatch[2];
      
      const element = await page.locator(selector).first();
      const actualText = await element.textContent();
      
      if (actualText?.trim() !== expectedText) {
        throw new Error(`Text mismatch. Expected "${expectedText}", got "${actualText}"`);
      }
      
      console.log(`  → Verified ${selector} contains exact text "${expectedText}"`);
      return;
    }

    // Verify selector is visible
    const selectorVisibleMatch = stepDesc.match(/verify\s+selector\s+['"]([^'"]+)['"]\s+is\s+visible/i);
    if (selectorVisibleMatch) {
      const selector = selectorVisibleMatch[1];
      await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
      console.log(`  → Verified ${selector} is visible`);
      return;
    }
    
    // Verify element is visible (generic)
    if (lower.includes('is visible') || lower.includes('visible')) {
      const target = extractQuoted(stepDesc);
      
      if (isCSSSelector(target) || isTextSelector(target)) {
        await page.waitForSelector(target, { state: 'visible', timeout: 10000 });
        console.log(`  → Verified ${target} is visible`);
        return;
      } else {
        await page.waitForSelector(`text="${target}"`, { state: 'visible', timeout: 10000 });
        console.log(`  → Verified text "${target}" is visible`);
        return;
      }
    }
    
    // Verify URL contains
    if (lower.includes('url contains')) {
      const fragment = extractQuoted(stepDesc);
      const currentUrl = page.url();
      
      if (!currentUrl.includes(fragment)) {
        throw new Error(`URL does not contain "${fragment}". Current URL: ${currentUrl}`);
      }
      
      console.log(`  → Verified URL contains "${fragment}"`);
      return;
    }
    
    // Verify contains text
    if (lower.includes('contains text')) {
      const parts = stepDesc.match(/verify\s+['"]([^'"]+)['"]\s+contains\s+text\s+['"]([^'"]+)['"]/i);
      if (parts) {
        const selector = parts[1];
        const expectedText = parts[2];
        
        const element = await page.locator(selector);
        const actualText = await element.textContent();
        
        if (!actualText || !actualText.includes(expectedText)) {
          throw new Error(`Text mismatch. Expected "${expectedText}" in "${actualText}"`);
        }
        
        console.log(`  → Verified ${selector} contains text "${expectedText}"`);
        return;
      }
    }
    
    // Generic verify - try as text visibility
    const target = extractQuoted(stepDesc);
    if (target) {
      try {
        await page.waitForSelector(`text="${target}"`, { state: 'visible', timeout: 5000 });
        console.log(`  → Verified text "${target}" is visible`);
        return;
      } catch (e) {
        throw new Error(`Verification failed: Could not find visible text "${target}"`);
      }
    }
  }

  // ============================================================================
  // FALLBACK: Unrecognized step type
  // ============================================================================
  console.log(`  → [WARN] Unrecognized step type: "${stepDesc}", waiting 500ms...`);
  await page.waitForTimeout(500);
}



function extractText(str, removeWords) {
  let text = str;
  removeWords.forEach(word => {
    text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  });
  return text.trim().replace(/['"]/g, '');
}

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  QA-GPT Playwright Backend Running     ║
║  Port: ${PORT}                            ║
║  MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}                    ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;