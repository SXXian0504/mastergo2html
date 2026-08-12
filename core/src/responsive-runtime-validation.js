import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 900 },
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'wide-desktop', width: 2560, height: 1440 },
])

const DEFAULT_MODULES = Object.freeze([
  { role: 'header', selectors: ['header', '[role="banner"]', '[data-module-type="header"]', '[class~="site-header"]', '[class*="__header"]'] },
  { role: 'nav', selectors: ['nav', '[role="navigation"]', '[class~="primary-nav"]', '[class*="__nav"]'] },
  { role: 'main', selectors: ['main', '[role="main"]', '[data-module-type="content-section"]', '[class~="page-main"]', '[class*="__main"]'] },
  { role: 'footer', selectors: ['footer', '[role="contentinfo"]', '[data-module-type="footer"]', '[class~="site-footer"]', '[class*="__footer"]'] },
])

export async function runResponsiveRuntimeValidation({
  outputDir,
  contract = null,
  chromePath = process.env.CHROME_PATH,
  timeoutMs = Number(process.env.RESPONSIVE_RUNTIME_TIMEOUT_MS || 45_000),
} = {}) {
  if (!contract || contract.enabled === false) return skippedResult('当前生成目标未启用 Web 响应式运行时检测。', contract)
  const executable = resolveChromeExecutable(chromePath)
  if (!executable) return skippedResult('未找到可用的 Chrome/Chromium，已跳过多视口运行时检测。', contract)
  if (!outputDir || !existsSync(join(outputDir, 'index.html'))) {
    return skippedResult('输出目录缺少 index.html，无法执行多视口运行时检测。', contract)
  }

  const server = await startStaticServer(outputDir)
  const profileDir = mkdtempSync(join(tmpdir(), 'mastergo2html-responsive-'))
  let browser
  try {
    browser = await launchChrome(executable, profileDir, timeoutMs)
    const client = await createCdpClient(browser.webSocketUrl, timeoutMs)
    try {
      const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
      await client.send('Page.enable', {}, sessionId)
      await client.send('Runtime.enable', {}, sessionId)

      const viewports = normalizeViewports(contract?.viewports)
      const requiredModules = normalizeRequiredModules(contract?.requiredModules)
      const tolerancePx = finiteNumber(contract?.horizontalScrolling?.tolerancePx, 2)
      const reports = []
      for (const viewport of viewports) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width <= 768,
          screenWidth: viewport.width,
          screenHeight: viewport.height,
        }, sessionId)
        const loaded = client.waitFor('Page.loadEventFired', sessionId, timeoutMs)
        await client.send('Page.navigate', { url: `${server.url}/index.html?responsive-viewport=${viewport.width}` }, sessionId)
        await loaded
        await client.send('Runtime.evaluate', {
          expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : Promise.resolve(true)',
          awaitPromise: true,
          returnByValue: true,
        }, sessionId)
        const evaluated = await client.send('Runtime.evaluate', {
          expression: buildInspectionExpression({ viewport, requiredModules, tolerancePx, layoutIntegrity: contract?.layoutIntegrity }),
          returnByValue: true,
          awaitPromise: true,
        }, sessionId)
        reports.push(evaluated?.result?.value || {
          viewport,
          ok: false,
          warnings: [`${viewport.width}px 视口未返回有效检测数据。`],
        })
      }
      await client.send('Target.closeTarget', { targetId }).catch(() => {})
      const warnings = reports.flatMap((report) => report.warnings || [])
      return {
        version: 'mastergo2html.responsive-runtime-validation.v1',
        status: warnings.length === 0 ? 'passed' : 'warning',
        ok: warnings.length === 0,
        blocking: false,
        autoFixed: false,
        chromePath: executable,
        viewports: reports,
        warnings: [...new Set(warnings)],
        checkedAt: new Date().toISOString(),
      }
    } finally {
      client.close()
    }
  } catch (error) {
    return skippedResult(`多视口运行时检测执行失败：${error instanceof Error ? error.message : String(error)}`, contract, 'warning')
  } finally {
    await stopChrome(browser?.process)
    await server.close()
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Chrome can briefly recreate profile files while exiting. Cleanup must not fail generation.
    }
  }
}

async function stopChrome(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    child.kill('SIGTERM')
  })
}

export function buildInspectionExpression({ viewport, requiredModules, tolerancePx = 2, layoutIntegrity = null }) {
  return `(async () => {
    const viewport = ${JSON.stringify(viewport)};
    const requiredModules = ${JSON.stringify(requiredModules)};
    const tolerance = ${Number(tolerancePx) || 2};
    const layoutIntegrity = ${JSON.stringify(layoutIntegrity || {})};
    const root = document.documentElement;
    const body = document.body;
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const describe = (element) => {
      const className = typeof element.className === 'string' ? element.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
      return element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (className ? '.' + className : '');
    };
    const isMeaningfulContent = (element) => {
      if (!isVisible(element)) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      const tag = element.tagName.toLowerCase();
      const interactive = /^(a|button|input|select|textarea)$/.test(tag) || element.getAttribute('role') === 'button';
      if (interactive) return true;
      if (/^(img|picture|svg|canvas|video)$/.test(tag)) {
        if (tag === 'img' && element.getAttribute('alt') === '' && !element.closest('a,button')) return false;
        return true;
      }
      return Boolean(String(element.innerText || element.textContent || '').trim());
    };
    const meaningfulRects = (element) => {
      const owner = element.getBoundingClientRect();
      const candidates = [...new Set([...element.querySelectorAll('a,button,input,select,textarea,img,picture,svg,canvas,video,h1,h2,h3,h4,h5,h6,p,li,[data-text-source-node-id],[data-source-node-id]')])]
        .filter(isMeaningfulContent)
        .map((item) => item.getBoundingClientRect())
        .map((rect) => ({
          left: Math.max(owner.left, rect.left),
          right: Math.min(owner.right, rect.right),
          top: Math.max(owner.top, rect.top),
          bottom: Math.min(owner.bottom, rect.bottom),
        }))
        .filter((rect) => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
      const unique = [];
      for (const rect of candidates) {
        if (unique.some((item) => Math.abs(item.left - rect.left) < 1 && Math.abs(item.right - rect.right) < 1 && Math.abs(item.top - rect.top) < 1 && Math.abs(item.bottom - rect.bottom) < 1)) continue;
        unique.push(rect);
      }
      return unique;
    };
    const largestGap = (intervals, start, end, includeEdges = true) => {
      if (!intervals.length || end <= start) return { size: includeEdges ? Math.max(0, end - start) : 0, ratio: includeEdges ? 1 : 0, intervals: 0 };
      const merged = intervals
        .map((item) => ({ start: Math.max(start, item.start), end: Math.min(end, item.end) }))
        .filter((item) => item.end > item.start)
        .sort((a, b) => a.start - b.start)
        .reduce((output, item) => {
          const last = output[output.length - 1];
          if (last && item.start <= last.end + 1) last.end = Math.max(last.end, item.end);
          else output.push({ ...item });
          return output;
        }, []);
      let max = includeEdges ? Math.max(0, (merged[0]?.start || start) - start, end - (merged[merged.length - 1]?.end || end)) : 0;
      for (let index = 1; index < merged.length; index += 1) max = Math.max(max, merged[index].start - merged[index - 1].end);
      const ratioSpan = includeEdges ? end - start : (merged[merged.length - 1]?.end || end) - (merged[0]?.start || start);
      return { size: Math.round(max * 100) / 100, ratio: Math.round((max / Math.max(1, ratioSpan)) * 1000) / 1000, intervals: merged.length };
    };
    const inspectOverflowElement = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const contentOverflowX = element.scrollWidth > element.clientWidth + tolerance;
      return {
        element: describe(element),
        rect: { left: Math.round(rect.left * 100) / 100, right: Math.round(rect.right * 100) / 100, top: Math.round(rect.top * 100) / 100, bottom: Math.round(rect.bottom * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: style.overflowX,
        contentOverflowX,
        horizontalScroller: contentOverflowX && /^(auto|scroll)$/.test(style.overflowX),
        outsideViewport: rect.left < -tolerance || rect.right > viewport.width + tolerance,
      };
    };
    const inspectElement = (element) => {
      const overflow = inspectOverflowElement(element);
      const contentRects = meaningfulRects(element);
      return {
        ...overflow,
        meaningfulContentCount: contentRects.length,
        verticalWhitespace: largestGap(contentRects.map((item) => ({ start: item.top, end: item.bottom })), overflow.rect.top, overflow.rect.top + overflow.rect.height),
        horizontalWhitespace: largestGap(contentRects.map((item) => ({ start: item.left, end: item.right })), overflow.rect.left, overflow.rect.right, false),
      };
    };
    const rounded = (value) => Math.round(Number(value || 0) * 100) / 100;
    const rectSnapshot = (rect) => ({ left: rounded(rect.left), right: rounded(rect.right), top: rounded(rect.top), bottom: rounded(rect.bottom), width: rounded(rect.width), height: rounded(rect.height) });
    const waitForGeometry = (delayMs) => new Promise((resolvePromise) => {
      requestAnimationFrame(() => setTimeout(resolvePromise, Math.max(0, Number(delayMs) || 0)));
    });
    const inspectSegmentedControls = async () => {
      const rules = layoutIntegrity.segmentedControls || {};
      if (rules.enabled === false) return [];
      const controlSelector = String(rules.selector || '[data-segmented-control], [role=\"tablist\"]');
      const surfaceSelectors = Array.isArray(rules.activeSurfaceSelectors) && rules.activeSurfaceSelectors.length
        ? rules.activeSurfaceSelectors
        : [
            '[data-segmented-active-surface]',
            '[data-active-surface]',
            '[class*=\"active\"][class*=\"bg\"]',
            '[class*=\"active\"][class*=\"background\"]',
            '[class*=\"active\"][class*=\"indicator\"]',
            '[class*=\"selected\"][class*=\"bg\"]',
            '[class*=\"selected\"][class*=\"indicator\"]',
          ];
      const centerTolerancePx = Number(rules.centerTolerancePx ?? tolerance);
      const boundaryTolerancePx = Number(rules.boundaryTolerancePx ?? tolerance);
      const minActiveWidthRatio = Number(rules.minActiveWidthToSlotRatio ?? 0.9);
      const maxActiveWidthRatio = Number(rules.maxActiveWidthToSlotRatio ?? 1.1);
      const minClickWidthRatio = Number(rules.minClickWidthToSlotRatio ?? 0.9);
      const minClickHeightRatio = Number(rules.minClickHeightToControlRatio ?? 0.9);
      const settleMs = Number(rules.settleMs ?? 220);
      const exerciseAllTabs = rules.exerciseAllTabs !== false;
      const controls = [...document.querySelectorAll(controlSelector)].filter(isVisible);
      const reports = [];
      for (const control of controls) {
        const tabs = [...control.querySelectorAll('[role=\"tab\"], button[data-segmented-item]')].filter(isVisible);
        if (tabs.length < 2) continue;
        let activeSurface = null;
        for (const selector of surfaceSelectors) {
          try {
            activeSurface = [...control.querySelectorAll(selector)].find((element) => isVisible(element) && !element.matches('[role=\"tab\"],button,a'));
          } catch {
            activeSurface = null;
          }
          if (activeSurface) break;
        }
        const explicit = control.hasAttribute('data-segmented-control');
        if (!activeSurface && !explicit) continue;
        const controlRect = control.getBoundingClientRect();
        if (activeSurface && !explicit) {
          const surfaceRect = activeSurface.getBoundingClientRect();
          const surfaceStyle = getComputedStyle(activeSurface);
          const radius = Math.max(
            parseFloat(surfaceStyle.borderTopLeftRadius) || 0,
            parseFloat(surfaceStyle.borderTopRightRadius) || 0,
            parseFloat(surfaceStyle.borderBottomLeftRadius) || 0,
            parseFloat(surfaceStyle.borderBottomRightRadius) || 0,
          );
          const minDetectionHeightRatio = Number(rules.minActiveHeightToControlRatioForDetection ?? 0.35);
          if (radius < 4 || surfaceRect.height / Math.max(1, controlRect.height) < minDetectionHeightRatio) continue;
        }
        const slotWidth = controlRect.width / tabs.length;
        const checks = [];
        const localWarnings = [];
        if (!activeSurface) {
          localWarnings.push(viewport.width + 'px 分段控件缺少可识别的活动视觉面：' + describe(control) + '；请给活动胶囊添加 data-segmented-active-surface');
        } else if (activeSurface.matches('[role=\"tab\"],button,a') || tabs.some((tab) => activeSurface.contains(tab))) {
          localWarnings.push(viewport.width + 'px 分段控件未分离活动视觉面与按钮点击区：' + describe(control));
        }
        for (const tab of tabs) {
          const tabRect = tab.getBoundingClientRect();
          const widthRatio = tabRect.width / Math.max(1, slotWidth);
          const heightRatio = tabRect.height / Math.max(1, controlRect.height);
          if (widthRatio < minClickWidthRatio || heightRatio < minClickHeightRatio) {
            localWarnings.push(viewport.width + 'px 分段按钮点击区未覆盖完整槽位：' + describe(tab) + '，宽度比=' + rounded(widthRatio) + '，高度比=' + rounded(heightRatio));
          }
        }
        if (activeSurface) {
          const targets = exerciseAllTabs ? tabs : [tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0]];
          for (let index = 0; index < targets.length; index += 1) {
            const tab = targets[index];
            if (exerciseAllTabs && tab.getAttribute('aria-disabled') !== 'true' && !tab.disabled) {
              tab.click();
              await waitForGeometry(settleMs);
            }
            const tabRect = tab.getBoundingClientRect();
            const surfaceRect = activeSurface.getBoundingClientRect();
            const centerError = Math.abs((tabRect.left + tabRect.width / 2) - (surfaceRect.left + surfaceRect.width / 2));
            const widthRatio = surfaceRect.width / Math.max(1, slotWidth);
            const inside = surfaceRect.left >= controlRect.left - boundaryTolerancePx
              && surfaceRect.right <= controlRect.right + boundaryTolerancePx
              && surfaceRect.top >= controlRect.top - boundaryTolerancePx
              && surfaceRect.bottom <= controlRect.bottom + boundaryTolerancePx;
            const selected = tab.getAttribute('aria-selected');
            checks.push({
              index,
              tab: describe(tab),
              tabRect: rectSnapshot(tabRect),
              activeSurfaceRect: rectSnapshot(surfaceRect),
              centerErrorPx: rounded(centerError),
              activeWidthToSlotRatio: rounded(widthRatio),
              insideControl: inside,
              ariaSelected: selected,
            });
            if (centerError > centerTolerancePx) {
              localWarnings.push(viewport.width + 'px 分段活动胶囊未与第 ' + (index + 1) + ' 个选项中心对齐：误差 ' + rounded(centerError) + 'px');
            }
            if (!inside) {
              localWarnings.push(viewport.width + 'px 分段活动胶囊越出整体外框：第 ' + (index + 1) + ' 项');
            }
            if (widthRatio < minActiveWidthRatio || widthRatio > maxActiveWidthRatio) {
              localWarnings.push(viewport.width + 'px 分段活动胶囊宽度未继承单槽位比例：第 ' + (index + 1) + ' 项，比例 ' + rounded(widthRatio));
            }
            if (exerciseAllTabs && selected !== null && selected !== 'true') {
              localWarnings.push(viewport.width + 'px 分段控件切换后 aria-selected 未同步：第 ' + (index + 1) + ' 项');
            }
          }
        }
        reports.push({
          element: describe(control),
          tabCount: tabs.length,
          controlRect: rectSnapshot(controlRect),
          slotWidth: rounded(slotWidth),
          activeSurface: activeSurface ? describe(activeSurface) : null,
          checks,
          warnings: [...new Set(localWarnings)],
        });
      }
      return reports;
    };
    const moduleElementSet = new Set();
    const modules = requiredModules.map((module) => {
      let matches = [...new Set(module.selectors.flatMap((selector) => {
        try { return [...document.querySelectorAll(selector)]; } catch { return []; }
      }))]
        .filter((element) => module.role !== 'nav' || !element.closest('footer,[role="contentinfo"]'))
        .filter(isVisible);
      if (module.role === 'nav' && matches.length === 0) {
        matches = [...document.querySelectorAll('[aria-controls]')].filter((trigger) => {
          if (!isVisible(trigger)) return false;
          const targetId = trigger.getAttribute('aria-controls');
          const target = targetId ? document.getElementById(targetId) : null;
          return Boolean(target && target.matches('nav,[role="navigation"]'));
        });
      }
      matches.forEach((element) => moduleElementSet.add(element));
      return {
        role: module.role,
        required: module.required !== false,
        present: matches.length > 0,
        elements: matches.slice(0, 12).map(inspectElement),
      };
    });
    const horizontalOverflowElements = [...document.querySelectorAll('*')]
      .filter((element) => !moduleElementSet.has(element) && isVisible(element))
      .map(inspectOverflowElement)
      .filter((item) => item.contentOverflowX)
      .slice(0, 40);
    const pageScrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const pageOverflow = pageScrollWidth > viewport.width + tolerance;
    const warnings = [];
    const narrowMaxWidth = Number(layoutIntegrity.narrowMaxWidth || 768);
    const headerRules = layoutIntegrity.header || {};
    const wideRules = layoutIntegrity.wideShell || {};
    const footerRules = layoutIntegrity.footer || {};
    const segmentedControls = await inspectSegmentedControls();
    for (const item of segmentedControls) warnings.push(...item.warnings);
    for (const module of modules) {
      if (module.required && !module.present) warnings.push(viewport.width + 'px 缺少必检模块：' + module.role);
      for (const item of module.elements) {
        if (item.contentOverflowX) warnings.push(viewport.width + 'px 必检模块仍保留超宽内容：' + module.role + ' -> ' + item.element + '（scrollWidth=' + item.scrollWidth + '，clientWidth=' + item.clientWidth + '）');
        if (item.outsideViewport) warnings.push(viewport.width + 'px 必检模块超出视口：' + module.role + ' -> ' + item.element);
      }
      const primary = [...module.elements].sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
      if (!primary) continue;
      if (module.role === 'header' && viewport.width <= narrowMaxWidth && headerRules.contentDrivenHeight !== false) {
        const maxGapPx = Number(headerRules.maxEmptyBandPx || 72);
        const maxGapRatio = Number(headerRules.maxEmptyBandRatio || 0.28);
        if (primary.meaningfulContentCount === 0 && primary.rect.height > maxGapPx) {
          warnings.push(viewport.width + 'px Header 可见容器没有内容但仍占高 ' + primary.rect.height + 'px，隐藏导航 wrapper 未折叠');
        } else if (primary.verticalWhitespace.size > maxGapPx && primary.verticalWhitespace.ratio > maxGapRatio) {
          warnings.push(viewport.width + 'px Header 出现结构性空白带：' + primary.verticalWhitespace.size + 'px（' + Math.round(primary.verticalWhitespace.ratio * 100) + '%）');
        }
      }
      const wideMin = Number(wideRules.minViewportWidth || 1921);
      const fullBleedRoles = Array.isArray(wideRules.fullBleedRoles) ? wideRules.fullBleedRoles : ['header', 'footer'];
      if (viewport.width >= wideMin && fullBleedRoles.includes(module.role)) {
        const minCoverage = Number(wideRules.minViewportCoverageRatio || 0.98);
        if (primary.rect.width < viewport.width * minCoverage) {
          warnings.push(viewport.width + 'px ' + module.role + ' 外层未全宽覆盖视口：' + primary.rect.width + '/' + viewport.width + 'px');
        }
      }
      if (module.role === 'footer' && viewport.width >= Number(wideRules.minViewportWidth || 1921)) {
        const maxGapRatio = Number(footerRules.maxDisconnectedGapRatio || 0.34);
        if (primary.horizontalWhitespace.intervals >= 2 && primary.horizontalWhitespace.ratio > maxGapRatio) {
          warnings.push(viewport.width + 'px Footer 内容出现横向断裂孤岛：最大空档 ' + primary.horizontalWhitespace.size + 'px（' + Math.round(primary.horizontalWhitespace.ratio * 100) + '%）');
        }
      }
    }
    if (pageOverflow) warnings.push(viewport.width + 'px 页面整体横向溢出：scrollWidth=' + pageScrollWidth + '，viewport=' + viewport.width);
    for (const item of horizontalOverflowElements) {
      if (item.horizontalScroller) warnings.push(viewport.width + 'px 组件发生横向滚动：' + item.element + '（' + item.scrollWidth + '>' + item.clientWidth + '）');
    }
    return {
      viewport,
      ok: warnings.length === 0,
      page: { clientWidth: root.clientWidth, scrollWidth: pageScrollWidth, horizontalOverflow: pageOverflow },
      modules,
      horizontalOverflowElements,
      segmentedControls,
      warnings: [...new Set(warnings)],
    };
  })()`
}

function normalizeViewports(viewports) {
  const source = Array.isArray(viewports) && viewports.length > 0 ? viewports : DEFAULT_VIEWPORTS
  return source
    .map((viewport, index) => ({
      name: String(viewport?.name || `viewport-${index + 1}`),
      width: Math.round(Number(viewport?.width)),
      height: Math.round(Number(viewport?.height || Math.max(844, Number(viewport?.width) * 0.75))),
    }))
    .filter((viewport) => viewport.width > 0 && viewport.height > 0)
}

function normalizeRequiredModules(modules) {
  const source = Array.isArray(modules) && modules.length > 0 ? modules : DEFAULT_MODULES
  return source.map((module) => ({
    role: String(module?.role || 'unknown'),
    selectors: Array.isArray(module?.selectors) && module.selectors.length > 0 ? module.selectors.map(String) : [],
    required: module?.required !== false,
  }))
}

function resolveChromeExecutable(explicitPath) {
  const candidates = [
    explicitPath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || null
}

async function launchChrome(executable, profileDir, timeoutMs) {
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const webSocketUrl = await new Promise((resolvePromise, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('等待 Chrome DevTools 地址超时')), timeoutMs)
    const finish = (callback, value) => {
      clearTimeout(timer)
      child.stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      callback(value)
    }
    const onData = (chunk) => {
      stderr += String(chunk)
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) finish(resolvePromise, match[1])
    }
    const onError = (error) => finish(reject, error)
    const onExit = (code) => finish(reject, new Error(`Chrome 在 DevTools 启动前退出：${code}; ${stderr.slice(-500)}`))
    child.stderr.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
  })
  return { process: child, webSocketUrl }
}

async function createCdpClient(webSocketUrl, timeoutMs) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Chrome DevTools 超时')), timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 Chrome DevTools 失败')) }, { once: true })
  })
  let id = 0
  const pending = new Map()
  const waiters = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 命令失败'))
      else entry.resolve(message.result || {})
      return
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter.method !== message.method || waiter.sessionId !== (message.sessionId || null)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message.params || {})
    }
  })
  return {
    send(method, params = {}, sessionId = null) {
      return new Promise((resolvePromise, reject) => {
        const commandId = ++id
        const timer = setTimeout(() => {
          pending.delete(commandId)
          reject(new Error(`CDP 命令超时：${method}`))
        }, timeoutMs)
        pending.set(commandId, { resolve: resolvePromise, reject, timer })
        socket.send(JSON.stringify({ id: commandId, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    waitFor(method, sessionId = null, waitTimeoutMs = timeoutMs) {
      return new Promise((resolvePromise, reject) => {
        const waiter = {
          method,
          sessionId,
          resolve: resolvePromise,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(new Error(`等待 CDP 事件超时：${method}`))
          }, waitTimeoutMs),
        }
        waiters.push(waiter)
      })
    },
    close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP 连接已关闭'))
      }
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('CDP 连接已关闭'))
      }
      pending.clear()
      waiters.length = 0
      socket.close()
    },
  }
}

async function startStaticServer(outputDir) {
  const root = resolve(outputDir)
  const server = http.createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent(String(request.url || '/').split('?')[0])
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
      const filePath = resolve(root, normalize(relativePath))
      if (filePath !== root && !filePath.startsWith(`${root}/`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end('Not Found')
        return
      }
      response.writeHead(200, { 'Content-Type': mimeType(filePath), 'Cache-Control': 'no-store' })
      response.end(readFileSync(filePath))
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  }
}

function mimeType(path) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  })[extname(path).toLowerCase()] || 'application/octet-stream'
}

function skippedResult(message, contract, status = 'skipped') {
  return {
    version: 'mastergo2html.responsive-runtime-validation.v1',
    status,
    ok: status === 'skipped',
    blocking: false,
    autoFixed: false,
    viewports: normalizeViewports(contract?.viewports).map((viewport) => ({ viewport, status: 'not-run' })),
    warnings: [message],
    checkedAt: new Date().toISOString(),
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
