import { AppState, Settings, DEFAULT_SETTINGS, DEFAULT_STATE, NarrativeTheme, CounterStrategy, DailyNarrativeStats, WhitelistEntry, TrustedBlurPhase, DEFAULT_BLUR_UNTIL_SCORED_TIMEOUT } from '../shared/types';
import { DEFAULT_BLUR_THRESHOLDS, DEFAULT_PHASE_TIMING, QUALITY_MODE_THRESHOLD, STRICTNESS_PRESETS, BlurThresholdSet, strictnessThresholds, thresholdsToStrictness } from '../shared/constants';
import { DEFAULT_GROUNDING } from '../shared/grounding-utils';
import { readStrictness, saveStrictness } from '../shared/strictness-settings';
import { getResearchOptIn, setResearchOptIn } from '../shared/research-consent';
import { renderTopics, setupTopics } from './topics';
import { showGroundingInvite } from '../content/grounding';
import { showWeekCard } from '../content/weekCard';
import type { WeekCardInfo } from '../background/weekReview';
import { getAllSessions, clearAllStores, getCalibrationData, getAllPostContent } from '../background/storage';
import { activeRubric, rubricHash, RUBRIC, SCORING_SPEC_VERSION } from '../shared/scoring-spec';
import { loadUsageChart } from '../shared/usage-chart';
import { getSecrets, setSecrets, withoutSecrets } from '../shared/secrets';
import type { HealthHistory, HealthReport } from '../shared/scrape-health';
import { USAGE_HISTORY_DAYS } from '../shared/usage-history';
import { CLAUDE_SITE, TIKTOK_SITE, hasAccess, requestAccess, removeAccess, requestEndpointAccess } from '../shared/optional-sites';
import type { RubricTestRow } from '../background/openrouter';

interface ApiUsage {
  totalCalls: number;
  totalCost: number;
  lastReset: number;
}

const PRO_SUBSCRIPTION_URL = 'https://tolerance.lol/account.html';

async function init(): Promise<void> {
  // Load state
  const state = await getState();
  updateModeDisplay(state);

  // Load settings
  const settings = await getSettings();
  populateSettings(settings);
  await populateKeys();
  await updateApiStatus(settings);

  // Load and render whitelist
  renderWhitelist(settings.whitelist || []);

  // Restore advanced settings visibility
  const showAdvanced = localStorage.getItem('tolerance-show-advanced') === 'true';
  const advancedCheckbox = document.getElementById('show-advanced') as HTMLInputElement;
  const advancedSection = document.getElementById('advanced-settings');
  if (advancedCheckbox && advancedSection) {
    advancedCheckbox.checked = showAdvanced;
    advancedSection.style.display = showAdvanced ? 'block' : 'none';
  }

  // Load and display dashboard data
  await loadDashboardData();

  // Load and display global session (progressive boredom)
  await loadGlobalSession();

  await loadUsageChart('usage-chart', USAGE_HISTORY_DAYS, 120);

  // Set up event listeners
  setupEventListeners();
  setupTopics({ onChange: loadNarrativeData, onEdit: openEditThemeModal });
  await setupTrustedBlurPhase();
  await setupGroundingSettings();
  await setupFacebookReelsSetting();
  await setupYouTubeShortsSetting();
  await setupResearchSetting();
  await setupFacebookAdsSetting();
  await setupAiLabelSetting();
  await setupScrapeHealth();
  setupWeekCardPreview();
  await setupSubscriptionsOnly();
  await setupRubricEditor();
  setupStrictnessSlider();

  // Listen for storage changes to sync Quality Mode toggle
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings?.newValue) {
      const newSettings = changes.settings.newValue as Settings;
      const qualityModeToggle = document.getElementById('quality-mode-toggle') as HTMLInputElement;
      const qualityModeSection = document.getElementById('quality-mode-section');
      const qualityModeStatus = document.getElementById('quality-mode-status');
      const isQualityMode = newSettings.qualityMode ?? false;

      if (qualityModeToggle && qualityModeToggle.checked !== isQualityMode) {
        qualityModeToggle.checked = isQualityMode;
      }
      if (qualityModeSection) {
        qualityModeSection.classList.toggle('active', isQualityMode);
      }
      if (qualityModeStatus) {
        qualityModeStatus.style.display = isQualityMode ? 'block' : 'none';
      }

      // Sync Opaque Blur toggle
      const opaqueBlurToggle = document.getElementById('opaque-blur-toggle') as HTMLInputElement;
      const isOpaqueBlur = newSettings.twitter?.opaqueBlur ?? true;
      if (opaqueBlurToggle && opaqueBlurToggle.checked !== isOpaqueBlur) {
        opaqueBlurToggle.checked = isOpaqueBlur;
      }
    }
  });

  // Set up threshold controls (top card + settings section)
  setupThresholdControls();
  void renderThresholdNow();

  // Scroll to API setup section if hash is present
  if (window.location.hash === '#api-setup') {
    scrollToApiSetup();
  } else if (window.location.hash === '#thresholds') {
    scrollToFineTune();
  }

  // Refresh global session every 30 seconds
  setInterval(loadGlobalSession, 30000);
}

async function getState(): Promise<AppState> {
  const result = await chrome.storage.local.get<{ state?: AppState }>('state');
  return result.state || DEFAULT_STATE;
}

// Dropdown: session phase at which trusted sources/subscriptions get blurred too
async function setupTrustedBlurPhase(): Promise<void> {
  const select = document.getElementById('trusted-blur-phase') as HTMLSelectElement | null;
  if (!select) return;

  const settings = await getSettings();
  select.value = settings.trustedBlurPhase ?? 'minimal';

  select.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({
      settings: { ...current, trustedBlurPhase: select.value as TrustedBlurPhase },
    });
  });
}

// Hide Facebook Reels card (on unless explicitly turned off)
async function setupFacebookReelsSetting(): Promise<void> {
  const toggle = document.getElementById('fb-reels-toggle') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = (await getSettings()).hideFacebookReels !== false;
  toggle.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({ settings: { ...current, hideFacebookReels: toggle.checked } });
  });
}

// Hide YouTube Shorts card (off unless turned on)
async function setupYouTubeShortsSetting(): Promise<void> {
  const toggle = document.getElementById('yt-shorts-toggle') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = (await getSettings()).hideYouTubeShorts !== false;
  toggle.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({ settings: { ...current, hideYouTubeShorts: toggle.checked } });
  });
}

// Research opt-in card (off unless turned on here or on the welcome page)
async function setupResearchSetting(): Promise<void> {
  const toggle = document.getElementById('research-toggle') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = await getResearchOptIn();
  toggle.addEventListener('change', () => setResearchOptIn(toggle.checked));
}

// Penalize Ads card (on unless explicitly turned off)
async function setupFacebookAdsSetting(): Promise<void> {
  const toggle = document.getElementById('fb-ads-toggle') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = (await getSettings()).penalizeFacebookAds !== false;
  toggle.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({
      settings: { ...current, penalizeFacebookAds: toggle.checked },
      topicsChangedAt: Date.now(), // re-score posts under the new setting
    });
  });
}

// Blur AI-Labeled Posts card (on unless explicitly turned off)
async function setupAiLabelSetting(): Promise<void> {
  const toggle = document.getElementById('ai-label-toggle') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = (await getSettings()).blurAiLabeled === true;
  toggle.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({
      settings: { ...current, blurAiLabeled: toggle.checked },
      topicsChangedAt: Date.now(), // re-score posts under the new setting
    });
  });
}

// Scraper Health Check card (developer; off unless turned on)
async function setupScrapeHealth(): Promise<void> {
  const toggle = document.getElementById('scrape-health-toggle') as HTMLInputElement | null;
  const box = document.getElementById('scrape-health-report');
  if (!toggle || !box) return;

  type Health = { history: HealthHistory; report: HealthReport | null; today: string };
  let latest: Health | null = null;
  const line = (text: string, className?: string): HTMLElement => {
    const div = document.createElement('div');
    div.textContent = text;
    if (className) div.className = className;
    return div;
  };

  const render = async (): Promise<void> => {
    box.replaceChildren();
    if (!toggle.checked) return;
    latest = await chrome.runtime.sendMessage({ type: 'GET_SCRAPE_HEALTH' }) as Health | null;
    if (!latest) return;
    const { history, report, today } = latest;

    if (!report) box.append(line('No check has run yet. It runs once a day, after a day with some browsing has finished.'));
    else if (report.alerts.length === 0) box.append(line(`Last check (${report.day}): no problems found.`, 'ok'));
    else {
      box.append(line(`Last check (${report.day}): ${report.alerts.length} problem${report.alerts.length === 1 ? '' : 's'}.`));
      for (const alert of report.alerts) box.append(line(alert.message, 'alert'));
    }

    // What was counted on the checked day and today, site by site
    for (const day of [...new Set([report?.day, today])].filter((d): d is string => !!d && !!history[d])) {
      const table = document.createElement('table');
      const head = table.insertRow();
      for (const h of [day === today ? `Today (${day})` : day, 'Feed pages', 'Posts', 'Found']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.append(th);
      }
      for (const [platform, counts] of Object.entries(history[day])) {
        const row = table.insertRow();
        const found = Object.entries(counts.fields)
          .map(([field, t]) => `${field} ${t.seen ? Math.round(t.found / t.seen * 100) : 0}% of ${t.seen}`).join(', ');
        for (const cell of [platform, String(counts.loads), String(counts.posts), found || 'nothing counted yet']) row.insertCell().textContent = cell;
      }
      box.append(table);
    }
  };

  toggle.checked = (await getSettings()).scrapeHealthCheck === true;
  toggle.addEventListener('change', async () => {
    const current = await getSettings();
    await chrome.storage.local.set({ settings: { ...current, scrapeHealthCheck: toggle.checked } });
    await render();
  });
  document.getElementById('scrape-health-run')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'RUN_SCRAPE_HEALTH_CHECK' });
    await render();
  });
  document.getElementById('scrape-health-copy')?.addEventListener('click', async (event) => {
    if (!latest) return;
    // The same thing an automated fixer would be handed: which site, which field, how bad
    const text = JSON.stringify({
      extensionVersion: chrome.runtime.getManifest().version,
      report: latest.report,
      counts: Object.fromEntries([...new Set([latest.report?.day, latest.today])].filter((d): d is string => !!d).map(d => [d, latest!.history[d] ?? {}])),
    }, null, 2);
    await navigator.clipboard.writeText(text);
    const button = event.currentTarget as HTMLButtonElement;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy report'; }, 1500);
  });
  await render();
}

// Subscriptions Only card: blur everything but subscribed channels and followed accounts
async function setupSubscriptionsOnly(): Promise<void> {
  const toggle = document.getElementById('subs-only-toggle') as HTMLInputElement | null;
  const desc = document.getElementById('subs-only-status');
  if (!toggle) return;

  const settings = await getSettings();
  toggle.checked = settings.subscriptionsOnly ?? false;

  // Show subscription count if synced
  if (desc && settings.subscriptionsOnly) {
    chrome.runtime.sendMessage({ type: 'GET_SUBSCRIPTIONS' }, (result) => {
      if (result?.subscriptions) {
        const ytCount = result.subscriptions.youtube?.length ?? 0;
        const lastSynced = result.subscriptions.lastSynced?.youtube;
        if (ytCount > 0) {
          desc.textContent = `Synced ${ytCount} YouTube channels`;
        } else if (lastSynced) {
          desc.textContent = 'No subscriptions found — sync again';
        } else {
          desc.textContent = 'Syncing subscriptions...';
        }
      }
    });
  }

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await chrome.storage.local.set({ settings: { ...(await getSettings()), subscriptionsOnly: enabled } });

    if (enabled) {
      // Trigger first sync when enabling
      if (desc) desc.textContent = 'Syncing subscriptions...';
      try {
        const syncResult = await chrome.runtime.sendMessage({
          type: 'SYNC_SUBSCRIPTIONS',
          platform: 'youtube',
        });
        if (syncResult?.count > 0) {
          if (desc) desc.textContent = `Synced ${syncResult.count} YouTube channels`;
        } else {
          if (desc) desc.textContent = 'No subscriptions found (are you logged into YouTube?)';
        }
      } catch {
        if (desc) desc.textContent = 'Sync failed — try again later';
      }
    } else if (desc) {
      desc.textContent = '';
    }

    // Notify all tabs to refresh their blur state
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'SUBSCRIPTIONS_ONLY_CHANGED', enabled });
        } catch {
          // Tab might not have content script
        }
      }
    }
  });
}

// When someone turns a site off, offer to turn Tolerance down instead: a tool that's
// too strict gets switched off, and one notch gentler may be all they wanted
async function offerTurnDown(siteInput: HTMLInputElement, siteName: string): Promise<void> {
  const offer = document.getElementById('turn-down-offer');
  const text = document.getElementById('turn-down-text');
  const gentler = document.getElementById('turn-down-accept');
  const keepOff = document.getElementById('turn-down-dismiss');
  if (!offer || !text || !gentler || !keepOff) return;

  const { level } = await readStrictness();
  if (level <= 1) return; // already as gentle as it goes

  const next = STRICTNESS_PRESETS[level - 2].label;
  text.textContent = `Too strict on ${siteName}? You can turn Tolerance down to ${next} and keep it on.`;
  gentler.style.display = '';
  keepOff.style.display = '';
  offer.style.display = 'block';

  keepOff.onclick = () => { offer.style.display = 'none'; };
  gentler.onclick = async () => {
    siteInput.checked = true;
    await saveSettings();
    await saveStrictness(level - 1);
    setThresholdSliders(strictnessThresholds(level - 1));
    updateStrictnessDisplay(strictnessThresholds(level - 1));
    void renderThresholdNow();
    text.textContent = `${siteName} is back on, and strictness is now ${next}.`;
    gentler.style.display = 'none';
    keepOff.style.display = 'none';
  };
}

// Scoring rubric card: edit the text posts are scored against, try it on the
// sample posts next to the default, then save or reset
async function setupRubricEditor(): Promise<void> {
  const textarea = document.getElementById('rubric-text') as HTMLTextAreaElement | null;
  const testBtn = document.getElementById('rubric-test-btn') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('rubric-save-btn') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('rubric-reset-btn') as HTMLButtonElement | null;
  const stateEl = document.getElementById('rubric-state');
  const resultsEl = document.getElementById('rubric-test-results');
  if (!textarea || !testBtn || !saveBtn || !resetBtn || !stateEl || !resultsEl) return;

  let saved = activeRubric((await getSettings()).scoringRubric);
  textarea.value = saved;

  const showState = (note?: string) => {
    const current = activeRubric(textarea.value);
    stateEl.textContent = note
      ?? (current !== saved ? 'Unsaved changes' : rubricHash(saved) ? 'Custom rubric' : 'Default rubric');
    stateEl.style.color = current !== saved ? '#e0b060' : '#888';
  };
  showState();
  textarea.addEventListener('input', () => showState());

  const save = async (rubric: string) => {
    const current = await getSettings();
    // The default is stored as unset, so it follows future changes to the built-in rubric
    await chrome.storage.local.set({ settings: { ...current, scoringRubric: rubricHash(rubric) ? rubric : undefined } });
    saved = rubric;
  };

  saveBtn.addEventListener('click', async () => {
    const rubric = activeRubric(textarea.value);
    textarea.value = rubric;
    await save(rubric);
    showState('Saved. Posts will be re-scored as you see them.');
  });

  resetBtn.addEventListener('click', async () => {
    textarea.value = RUBRIC;
    await save(RUBRIC);
    resultsEl.style.display = 'none';
    showState('Reset to the default rubric.');
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Scoring…';
    resultsEl.style.display = 'block';
    resultsEl.textContent = 'Scoring 10 sample posts with the default rubric and yours…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'TEST_RUBRIC', rubric: textarea.value }) as { rows?: RubricTestRow[] | null } | null;
      if (!result?.rows) {
        resultsEl.textContent = 'Could not score: check the API configuration above.';
      } else {
        renderRubricTest(resultsEl, result.rows);
      }
    } catch (e) {
      resultsEl.textContent = `Test failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test on sample posts';
    }
  });
}

function renderRubricTest(container: HTMLElement, rows: RubricTestRow[]): void {
  container.textContent = '';
  const table = document.createElement('table');
  table.style.cssText = 'width: 100%; border-collapse: collapse;';
  const head = table.insertRow();
  for (const label of ['Post', 'Default', 'Yours', 'Why (yours)']) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = 'text-align: left; color: #888; font-weight: normal; padding: 6px 8px; border-bottom: 1px solid #333;';
    head.appendChild(th);
  }
  for (const row of rows) {
    const tr = table.insertRow();
    const moved = row.defaultScore !== undefined && row.testScore !== undefined && Math.abs(row.testScore - row.defaultScore) >= 2;
    const cells = [
      row.text.length > 90 ? `${row.text.slice(0, 90)}…` : row.text,
      row.defaultScore?.toString() ?? '–',
      row.testScore?.toString() ?? '–',
      row.testReason ?? '',
    ];
    cells.forEach((text, i) => {
      const td = tr.insertCell();
      td.textContent = text;
      td.style.cssText = `padding: 6px 8px; border-bottom: 1px solid #222; color: ${i === 2 && moved ? '#e0b060' : '#ccc'};${i === 1 || i === 2 ? ' text-align: center;' : ''}`;
    });
  }
  container.appendChild(table);
  const note = document.createElement('div');
  note.textContent = 'Scores are 1-10. Yours is highlighted where it moved by 2 or more. Each test costs about the same as scoring 20 posts.';
  note.style.cssText = 'color: #666; font-size: 12px; margin-top: 8px;';
  container.appendChild(note);
}

// Grounding breaks card: on/off, interval, and a preview of the overlay
async function setupGroundingSettings(): Promise<void> {
  const toggle = document.getElementById('grounding-toggle') as HTMLInputElement | null;
  const select = document.getElementById('grounding-interval') as HTMLSelectElement | null;
  const tryButton = document.getElementById('grounding-try-btn');
  if (!toggle || !select) return;

  const settings = await getSettings();
  const grounding = { ...DEFAULT_GROUNDING, ...settings.grounding };
  toggle.checked = grounding.enabled;
  select.value = String(grounding.intervalMinutes);

  const save = async () => {
    const current = await getSettings();
    await chrome.storage.local.set({
      settings: {
        ...current,
        grounding: { enabled: toggle.checked, intervalMinutes: parseInt(select.value, 10) },
      },
    });
  };
  toggle.addEventListener('change', save);
  select.addEventListener('change', save);
  tryButton?.addEventListener('click', () => showGroundingInvite(undefined, { preview: true }));
}

// Developer: show the week-one card here, with this browser's numbers
function setupWeekCardPreview(): void {
  document.getElementById('week-card-preview')?.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_WEEK_CARD_PREVIEW' }) as { card: WeekCardInfo | null } | undefined;
    if (response?.card) showWeekCard({ ...response.card, preview: true });
  });
}

// ==========================================
// Strictness slider (one control for all four phase thresholds)
// ==========================================

const THRESHOLD_SLIDER_IDS: [string, keyof BlurThresholdSet][] = [
  ['blur-normal', 'normal'],
  ['blur-reduced', 'reduced'],
  ['blur-winddown', 'windDown'],
  ['blur-minimal', 'minimal'],
];

// The per-phase sliders hold 120 - threshold (20..100 maps onto itself), so moving
// right lowers the threshold and blurs more, like the Strictness slider, and the
// filled part of the track grows with how much gets blurred
function toSliderValue(threshold: number): string {
  return String(120 - threshold);
}

function sliderThreshold(slider: HTMLInputElement | null, fallback: number): number {
  const v = parseInt(slider?.value ?? '', 10);
  return Number.isNaN(v) ? fallback : 120 - v;
}

// Set both copies (top card + settings section) of the per-phase sliders
function setThresholdSliders(thresholds: BlurThresholdSet): void {
  for (const [id, key] of THRESHOLD_SLIDER_IDS) {
    for (const suffix of ['', '-top']) {
      const slider = document.getElementById(`${id}${suffix}`) as HTMLInputElement | null;
      const valueEl = document.getElementById(`${id}-value${suffix}`);
      if (slider) slider.value = toSliderValue(thresholds[key]);
      if (valueEl) valueEl.textContent = String(thresholds[key]);
    }
  }
}

function readThresholdSliders(): BlurThresholdSet {
  const read = (id: string, fallback: number) =>
    sliderThreshold(document.getElementById(`${id}-top`) as HTMLInputElement | null, fallback);
  return {
    normal: read('blur-normal', DEFAULT_BLUR_THRESHOLDS.normal),
    reduced: read('blur-reduced', DEFAULT_BLUR_THRESHOLDS.reduced),
    windDown: read('blur-winddown', DEFAULT_BLUR_THRESHOLDS.windDown),
    minimal: read('blur-minimal', DEFAULT_BLUR_THRESHOLDS.minimal),
  };
}

// Position the strictness slider to match the per-phase values ("Custom" if fine-tuned)
function updateStrictnessDisplay(thresholds: BlurThresholdSet): void {
  const slider = document.getElementById('strictness') as HTMLInputElement | null;
  const label = document.getElementById('strictness-value');
  const { level, exact } = thresholdsToStrictness(thresholds);
  if (slider) slider.value = String(level);
  if (label) label.textContent = exact ? STRICTNESS_PRESETS[level - 1].label : 'Custom';
}

function setupStrictnessSlider(): void {
  const slider = document.getElementById('strictness') as HTMLInputElement | null;
  const label = document.getElementById('strictness-value');
  if (!slider) return;

  slider.addEventListener('input', () => {
    const level = parseInt(slider.value, 10);
    if (label) label.textContent = STRICTNESS_PRESETS[level - 1].label;
    setThresholdSliders(strictnessThresholds(level));
  });
  slider.addEventListener('change', saveCustomThresholds);

  // Fine-tuning a single phase moves the strictness slider to "Custom"
  for (const [id] of THRESHOLD_SLIDER_IDS) {
    for (const suffix of ['', '-top']) {
      document.getElementById(`${id}${suffix}`)?.addEventListener('input', () => {
        updateStrictnessDisplay(readThresholdSliders());
      });
    }
  }

  updateStrictnessDisplay(readThresholdSliders());
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get<{ settings?: Settings }>('settings');
  return result.settings || DEFAULT_SETTINGS;
}

function updateModeDisplay(state: AppState): void {
  // Update baseline status in advanced settings
  const baselineStatus = document.getElementById('baseline-status');
  const toggleBaselineBtn = document.getElementById('toggle-baseline-btn');

  if (baselineStatus && toggleBaselineBtn) {
    if (state.mode === 'baseline') {
      const daysRemaining = calculateDaysRemaining(state);
      baselineStatus.textContent = `Baseline (${daysRemaining.toFixed(1)} days left)`;
      baselineStatus.style.color = '#7dcea0';
      toggleBaselineBtn.textContent = 'Exit Baseline';
    } else {
      baselineStatus.textContent = 'Active Mode';
      baselineStatus.style.color = '#888';
      toggleBaselineBtn.textContent = 'Enter Baseline';
    }
  }
}

function openProSubscription(): void {
  window.open(PRO_SUBSCRIPTION_URL, '_blank');
}

// The API key fields. Keys are kept apart from the settings (shared/secrets.ts), so
// they are filled in and saved separately.
async function populateKeys(): Promise<void> {
  const secrets = await getSecrets();
  const set = (id: string, value?: string): void => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = value || '';
  };
  set('api-key', secrets.openRouterApiKey);
  set('custom-api-key', secrets.customApiKey);
  set('rescuetime-key', secrets.rescueTimeApiKey);
}

async function updateApiStatus(settings: Settings): Promise<void> {
  const isFreeTier = settings.apiTier !== 'own-key';
  const hasOpenRouterKey = Boolean((await getSecrets()).openRouterApiKey?.trim());
  const hasCustomEndpoint = settings.apiProvider?.type === 'openai-compatible' &&
                            Boolean(settings.apiProvider?.endpoint?.trim());
  const isApiConfigured = isFreeTier || hasOpenRouterKey || hasCustomEndpoint;

  // Check for free tier exhaustion
  const errorStateResult = await chrome.storage.local.get('apiErrorState');
  const errorState = errorStateResult.apiErrorState as { exhausted: boolean; message: string } | undefined;
  const isExhausted = isFreeTier && errorState?.exhausted;
  const hasOwnKeyError = !isFreeTier && errorState?.exhausted;

  // Update header status
  const statusDot = document.getElementById('api-status-dot');
  const statusText = document.getElementById('api-status-text');

  if (statusDot && statusText) {
    if (isExhausted) {
      statusDot.style.background = '#e74c3c';
      statusText.textContent = 'Free Tier Exhausted (or use your own API key)';
      statusText.style.color = '#e74c3c';
    } else if (hasOwnKeyError) {
      statusDot.style.background = '#e74c3c';
      statusText.textContent = 'API Key Error';
      statusText.style.color = '#e74c3c';
    } else if (isApiConfigured) {
      statusDot.style.background = '#27ae60';
      if (isFreeTier) {
        statusText.textContent = 'Free Tier';
      } else if (hasCustomEndpoint) {
        statusText.textContent = 'Custom Endpoint';
      } else {
        statusText.textContent = 'API Connected';
      }
      statusText.style.color = '#27ae60';
    } else {
      statusDot.style.background = '#e74c3c';
      statusText.textContent = 'API Key Required';
      statusText.style.color = '#e74c3c';
    }
  }

  // Update setup section status
  const apiKeyStatus = document.getElementById('api-key-status');
  if (apiKeyStatus) {
    if (isExhausted) {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#4a2d2d';
      apiKeyStatus.style.color = '#ff9999';
      apiKeyStatus.innerHTML = '⚠ Free tier daily limit reached. <a href="https://tolerance.lol/account.html" target="_blank" style="color: #7dcea0; text-decoration: underline;">Upgrade to Pro</a> for unlimited usage, or add your own OpenRouter API key below.';
    } else if (hasOwnKeyError) {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#4a2d2d';
      apiKeyStatus.style.color = '#ff9999';
      apiKeyStatus.textContent = `⚠ ${errorState?.message || 'OpenRouter rejected the API key. Check the key\'s spend limit and account credits at openrouter.ai.'}`;
    } else if (isFreeTier) {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#1a472a';
      apiKeyStatus.style.color = '#7dcea0';
      apiKeyStatus.textContent = '✓ Free tier active. Tolerance is ready to use!';
    } else if (hasCustomEndpoint) {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#1a472a';
      apiKeyStatus.style.color = '#7dcea0';
      apiKeyStatus.textContent = '✓ Custom endpoint configured. Tolerance is active.';
    } else if (hasOpenRouterKey) {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#1a472a';
      apiKeyStatus.style.color = '#7dcea0';
      apiKeyStatus.textContent = '✓ API key configured. Tolerance is active.';
    } else {
      apiKeyStatus.style.display = 'block';
      apiKeyStatus.style.background = '#4a2d2d';
      apiKeyStatus.style.color = '#ff9999';
      apiKeyStatus.textContent = 'Enter your API key to enable post scoring.';
    }
  }
}

function calculateDaysRemaining(state: AppState): number {
  const msElapsed = Date.now() - state.baselineStartDate;
  const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
  return Math.max(0, state.baselineDurationDays - daysElapsed);
}

function populateSettings(settings: Settings): void {
  const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
  const apiSampleRateInput = document.getElementById('api-sample-rate') as HTMLInputElement;
  const ratioInput = document.getElementById('engagement-ratio') as HTMLInputElement;
  const cooldownInput = document.getElementById('cooldown-posts') as HTMLInputElement;
  const rescueTimeInput = document.getElementById('rescuetime-key') as HTMLInputElement;
  const todoistInput = document.getElementById('todoist-url') as HTMLInputElement;
  const jobSearchInput = document.getElementById('job-search-link') as HTMLInputElement;
  const hoverDelayInput = document.getElementById('hover-delay') as HTMLInputElement;
  const hoverDelayValue = document.getElementById('hover-delay-value');
  const blurIntensityInput = document.getElementById('blur-intensity') as HTMLInputElement;
  const blurIntensityValue = document.getElementById('blur-intensity-value');

  // API Tier selection
  const tierFree = document.getElementById('tier-free') as HTMLInputElement;
  const tierOwnKey = document.getElementById('tier-own-key') as HTMLInputElement;
  const ownKeySection = document.getElementById('own-key-section');
  const tierFreeLabel = document.getElementById('tier-free-label');
  const tierOwnKeyLabel = document.getElementById('tier-own-key-label');

  const currentTier = settings.apiTier || 'free';
  if (tierFree) tierFree.checked = currentTier === 'free';
  if (tierOwnKey) tierOwnKey.checked = currentTier === 'own-key';
  if (ownKeySection) ownKeySection.style.display = currentTier === 'own-key' ? 'flex' : 'none';

  // Update tier label styling
  if (tierFreeLabel) {
    tierFreeLabel.style.borderColor = currentTier === 'free' ? '#3d2d4a' : '#333';
    tierFreeLabel.style.background = currentTier === 'free' ? '#2a2a3a' : '#222';
  }
  if (tierOwnKeyLabel) {
    tierOwnKeyLabel.style.borderColor = currentTier === 'own-key' ? '#3d2d4a' : '#333';
    tierOwnKeyLabel.style.background = currentTier === 'own-key' ? '#2a2a3a' : '#222';
  }

  // Quality Mode toggle
  const qualityModeToggle = document.getElementById('quality-mode-toggle') as HTMLInputElement;
  const qualityModeSection = document.getElementById('quality-mode-section');
  const qualityModeStatus = document.getElementById('quality-mode-status');
  const isQualityMode = settings.qualityMode ?? false;
  if (qualityModeToggle) {
    qualityModeToggle.checked = isQualityMode;
  }
  if (qualityModeSection) {
    qualityModeSection.classList.toggle('active', isQualityMode);
  }
  if (qualityModeStatus) {
    qualityModeStatus.style.display = isQualityMode ? 'block' : 'none';
  }

  // Blur Until Scored toggle
  const blurUntilScoredToggle = document.getElementById('blur-until-scored-toggle') as HTMLInputElement;
  if (blurUntilScoredToggle) {
    blurUntilScoredToggle.checked = settings.blurUntilScored !== false;
  }
  const blurUntilScoredTimeoutSelect = document.getElementById('blur-until-scored-timeout') as HTMLSelectElement | null;
  if (blurUntilScoredTimeoutSelect) {
    blurUntilScoredTimeoutSelect.value = String(settings.blurUntilScoredTimeout ?? DEFAULT_BLUR_UNTIL_SCORED_TIMEOUT);
  }

  // Opaque Blur toggle
  const opaqueBlurToggle = document.getElementById('opaque-blur-toggle') as HTMLInputElement;
  if (opaqueBlurToggle) {
    opaqueBlurToggle.checked = settings.twitter?.opaqueBlur ?? true;
  }

  // Platform toggles
  const platformReddit = document.getElementById('platform-reddit') as HTMLInputElement;
  const platformTwitter = document.getElementById('platform-twitter') as HTMLInputElement;
  const platformYoutube = document.getElementById('platform-youtube') as HTMLInputElement;
  const platformInstagram = document.getElementById('platform-instagram') as HTMLInputElement;

  if (platformReddit) platformReddit.checked = settings.platforms?.reddit ?? true;
  if (platformTwitter) platformTwitter.checked = settings.platforms?.twitter ?? true;
  if (platformYoutube) platformYoutube.checked = settings.platforms?.youtube ?? true;
  if (platformInstagram) platformInstagram.checked = settings.platforms?.instagram ?? true;
  const platformFacebook = document.getElementById('platform-facebook') as HTMLInputElement | null;
  if (platformFacebook) platformFacebook.checked = settings.platforms?.facebook ?? true;

  // Productivity card toggle
  const productivityCardEnabled = document.getElementById('productivity-card-enabled') as HTMLInputElement;
  const productivityCardStatus = document.getElementById('productivity-card-status');
  if (productivityCardEnabled) {
    const enabled = settings.productivityCardEnabled ?? false;
    productivityCardEnabled.checked = enabled;
    if (productivityCardStatus) {
      productivityCardStatus.textContent = enabled ? 'Enabled' : 'Disabled';
      productivityCardStatus.style.color = enabled ? '#7dcea0' : '#888';
    }
  }

  // Claude filter toggle
  const claudeFilterEnabled = document.getElementById('claude-filter-enabled') as HTMLInputElement;
  if (claudeFilterEnabled) {
    claudeFilterEnabled.checked = settings.claudeFilterEnabled ?? false;
  }

  const claudeHideStreaming = document.getElementById('claude-hide-streaming') as HTMLInputElement;
  if (claudeHideStreaming) {
    claudeHideStreaming.checked = settings.claudeFilterHideWhileStreaming ?? false;
  }
  refreshClaudeStatus();

  // Claude filter threshold sliders
  const claudeThresholds = settings.claudeFilterThresholds || {
    skipFilter: 30,
    gentleReminder: 30,
    mediumReminder: 60,
    strongReminder: 90,
  };
  const claudeSliderConfig = [
    { id: 'claude-skip', value: claudeThresholds.skipFilter },
    { id: 'claude-gentle', value: claudeThresholds.gentleReminder },
    { id: 'claude-medium', value: claudeThresholds.mediumReminder },
    { id: 'claude-strong', value: claudeThresholds.strongReminder },
  ];
  for (const cfg of claudeSliderConfig) {
    const slider = document.getElementById(cfg.id) as HTMLInputElement;
    const valueEl = document.getElementById(`${cfg.id}-value`);
    if (slider) {
      slider.value = String(cfg.value);
      if (valueEl) valueEl.textContent = String(cfg.value);
    }
  }


  if (apiSampleRateInput) {
    // Convert from 0-1 to 0-100 for display
    apiSampleRateInput.value = String(Math.round((settings.apiSampleRate ?? 0.1) * 100));
  }

  if (ratioInput) {
    ratioInput.value = String(settings.scheduler?.highEngagementRatio ?? 0.2);
  }

  if (cooldownInput) {
    cooldownInput.value = String(settings.scheduler?.cooldownPosts ?? 5);
  }


  if (todoistInput && settings.todoistUrl) {
    todoistInput.value = settings.todoistUrl;
  }

  if (jobSearchInput && settings.jobSearchLink) {
    jobSearchInput.value = settings.jobSearchLink;
  }

  // Blur settings
  const hoverRevealInput = document.getElementById('hover-reveal') as HTMLInputElement;
  if (hoverRevealInput) hoverRevealInput.checked = settings.twitter?.hoverReveal ?? true;
  const hideBlurredBadgesInput = document.getElementById('hide-blurred-badges') as HTMLInputElement;
  if (hideBlurredBadgesInput) hideBlurredBadgesInput.checked = settings.twitter?.hideBlurredBadges ?? false;
  const hideBlurredYouTubeInput = document.getElementById('hide-blurred-youtube') as HTMLInputElement | null;
  if (hideBlurredYouTubeInput) hideBlurredYouTubeInput.checked = settings.twitter?.hideBlurredYouTube ?? false;

  if (hoverDelayInput) {
    const delay = settings.twitter?.hoverRevealDelay ?? 3;
    hoverDelayInput.value = String(delay);
    if (hoverDelayValue) hoverDelayValue.textContent = String(delay);
  }

  if (blurIntensityInput) {
    const intensity = settings.twitter?.blurIntensity ?? 8;
    blurIntensityInput.value = String(intensity);
    if (blurIntensityValue) blurIntensityValue.textContent = String(intensity);
  }

  // Log level
  const logLevelSelect = document.getElementById('log-level') as HTMLSelectElement;
  if (logLevelSelect) {
    logLevelSelect.value = settings.logLevel ?? 'error';
  }

  // Store post content toggle
  const storePostContentInput = document.getElementById('store-post-content') as HTMLInputElement;
  const storePostContentStatus = document.getElementById('store-post-content-status');
  if (storePostContentInput) {
    const enabled = settings.calibration?.storePostContent ?? false;
    storePostContentInput.checked = enabled;
    if (storePostContentStatus) {
      storePostContentStatus.textContent = enabled ? 'Enabled' : 'Disabled';
      storePostContentStatus.style.color = enabled ? '#7dcea0' : '#888';
    }
  }

  // Provider configuration
  const providerTypeSelect = document.getElementById('provider-type') as HTMLSelectElement;
  const customEndpointSection = document.getElementById('custom-endpoint-section');
  const customEndpointInput = document.getElementById('custom-endpoint') as HTMLInputElement;
  const customApiKeyInput = document.getElementById('custom-api-key') as HTMLInputElement;
  const customTextModelInput = document.getElementById('custom-text-model') as HTMLInputElement;
  const customVisionModelInput = document.getElementById('custom-vision-model') as HTMLInputElement;
  const trackCostsInput = document.getElementById('track-costs') as HTMLInputElement;
  const trackCostsStatus = document.getElementById('track-costs-status');

  const provider = settings.apiProvider || { type: 'openrouter' };

  if (providerTypeSelect) {
    providerTypeSelect.value = provider.type || 'openrouter';
  }
  if (customEndpointSection) {
    customEndpointSection.style.display = provider.type === 'openai-compatible' ? 'block' : 'none';
  }
  if (customEndpointInput) {
    customEndpointInput.value = provider.endpoint || '';
  }
  if (customTextModelInput) {
    customTextModelInput.value = provider.textModel || '';
  }
  if (customVisionModelInput) {
    customVisionModelInput.value = provider.imageModel || '';
  }
  if (trackCostsInput) {
    const trackCosts = provider.trackCosts !== false;
    trackCostsInput.checked = trackCosts;
    if (trackCostsStatus) {
      trackCostsStatus.textContent = trackCosts ? 'Enabled' : 'Disabled';
      trackCostsStatus.style.color = trackCosts ? '#7dcea0' : '#888';
    }
  }

  // Custom threshold sliders
  populateCustomThresholds(settings);
}

function populateCustomThresholds(settings: Settings): void {
  // Default values (calibrated defaults)
  const defaultBlurThresholds = DEFAULT_BLUR_THRESHOLDS;
  const defaultPhaseTiming = { normal: 15, reduced: 45, windDown: 75 };

  // Get custom values or use defaults
  const customEnabled = settings.customThresholds?.enabled ?? false;
  const blurThresholds = settings.customThresholds?.blurThresholds ?? defaultBlurThresholds;
  const phaseTiming = settings.customThresholds?.phaseTiming ?? defaultPhaseTiming;

  // Update status text
  const statusEl = document.getElementById('custom-thresholds-status');
  if (statusEl) {
    statusEl.textContent = customEnabled ? 'Using custom values' : 'Using calibrated defaults';
    statusEl.style.color = customEnabled ? '#f39c12' : '#666';
  }

  // Blur threshold sliders
  // Update both settings section and top card sliders
  const updateSlider = (id: string, value: number) => {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueEl = document.getElementById(`${id}-value`);
    const topSlider = document.getElementById(`${id}-top`) as HTMLInputElement;
    const topValueEl = document.getElementById(`${id}-value-top`);

    console.log(`updateSlider: ${id} = ${value}`, { slider: !!slider, valueEl: !!valueEl, topSlider: !!topSlider, topValueEl: !!topValueEl });

    if (slider) slider.value = toSliderValue(value);
    if (valueEl) valueEl.textContent = String(value);
    if (topSlider) topSlider.value = toSliderValue(value);
    if (topValueEl) topValueEl.textContent = String(value);
  };

  updateSlider('blur-normal', blurThresholds.normal);
  updateSlider('blur-reduced', blurThresholds.reduced);
  updateSlider('blur-winddown', blurThresholds.windDown);
  updateSlider('blur-minimal', blurThresholds.minimal);
  updateStrictnessDisplay(blurThresholds);

  // Phase timing sliders
  const timingNormal = document.getElementById('timing-normal') as HTMLInputElement;
  const timingReduced = document.getElementById('timing-reduced') as HTMLInputElement;
  const timingWinddown = document.getElementById('timing-winddown') as HTMLInputElement;

  if (timingNormal) {
    timingNormal.value = String(phaseTiming.normal);
    const valueEl = document.getElementById('timing-normal-value');
    if (valueEl) valueEl.textContent = String(phaseTiming.normal);
  }
  if (timingReduced) {
    timingReduced.value = String(phaseTiming.reduced);
    const valueEl = document.getElementById('timing-reduced-value');
    if (valueEl) valueEl.textContent = String(phaseTiming.reduced);
  }
  if (timingWinddown) {
    timingWinddown.value = String(phaseTiming.windDown);
    const valueEl = document.getElementById('timing-winddown-value');
    if (valueEl) valueEl.textContent = String(phaseTiming.windDown);
  }
  setPhaseTimeLabels(phaseTiming);
}

// "(15–45 min)" next to each per-phase slider, so the phase names mean something
function setPhaseTimeLabels(timing: { normal: number; reduced: number; windDown: number }): void {
  const labels: [string, string][] = [
    ['phase-time-normal', `(0–${timing.normal} min)`],
    ['phase-time-reduced', `(${timing.normal}–${timing.reduced} min)`],
    ['phase-time-winddown', `(${timing.reduced}–${timing.windDown} min)`],
    ['phase-time-minimal', `(${timing.windDown}+ min)`],
  ];
  for (const [id, text] of labels) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

async function loadDashboardData(): Promise<void> {
  try {
    // Get aggregate stats from background script via messaging
    const result = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }) as {
      stats: {
        sessionsCount: number;
        totalPosts: number;
        totalHigh: number;
        totalMedium: number;
        totalLow: number;
        postsReordered: number;
      };
      apiUsage: ApiUsage;
    } | null;

    if (!result?.stats) {
      console.error('Failed to get dashboard data');
      return;
    }

    const apiUsage = result.apiUsage || { totalCalls: 0, totalCost: 0, lastReset: Date.now() };

    console.log('Dashboard data received:', { ...result.stats, apiUsage });

    // Update API usage
    const apiCostEl = document.getElementById('api-cost');
    const apiCallsEl = document.getElementById('api-calls');

    if (apiCostEl) apiCostEl.textContent = `$${(apiUsage.totalCost || 0).toFixed(4)}`;
    if (apiCallsEl) apiCallsEl.textContent = String(apiUsage.totalCalls || 0);

  } catch (error) {
    console.error('Failed to load dashboard data:', error);
  }
}

function scrollToApiSetup(): void {
  const apiSetup = document.getElementById('api-setup');
  if (apiSetup) {
    apiSetup.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Focus the API key input after scrolling
    setTimeout(() => {
      const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
      if (apiKeyInput) {
        apiKeyInput.focus();
      }
    }, 500);
  }
}

// From the popup's "Fine-tune per phase" link: open the per-phase sliders and
// briefly outline the card so it's clear where to look
function scrollToFineTune(): void {
  const card = document.getElementById('thresholds');
  if (!card) return;
  (document.getElementById('threshold-fine-tune') as HTMLDetailsElement | null)?.setAttribute('open', '');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.style.boxShadow = '0 0 0 2px #7dcea0';
  setTimeout(() => { card.style.boxShadow = ''; }, 2000);
}

function setupEventListeners(): void {
  // API status header click - scroll to setup section
  const apiStatusHeader = document.getElementById('api-status-header');
  if (apiStatusHeader) {
    apiStatusHeader.addEventListener('click', scrollToApiSetup);
  }

  // Export button
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportData);
  }

  // Advanced settings toggle
  const advancedCheckbox = document.getElementById('show-advanced') as HTMLInputElement;
  const advancedSection = document.getElementById('advanced-settings');
  if (advancedCheckbox && advancedSection) {
    advancedCheckbox.addEventListener('change', () => {
      const show = advancedCheckbox.checked;
      advancedSection.style.display = show ? 'block' : 'none';
      localStorage.setItem('tolerance-show-advanced', String(show));
    });
  }

  // Baseline mode toggle button (in advanced settings)
  const toggleBaselineBtn = document.getElementById('toggle-baseline-btn');
  if (toggleBaselineBtn) {
    toggleBaselineBtn.addEventListener('click', toggleBaselineMode);
  }

  // Clear button
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearData);
  }

  // Quality Mode toggle
  const qualityModeToggle = document.getElementById('quality-mode-toggle') as HTMLInputElement;
  const qualityModeSection = document.getElementById('quality-mode-section');
  const qualityModeStatus = document.getElementById('quality-mode-status');
  if (qualityModeToggle) {
    qualityModeToggle.addEventListener('change', async () => {
      const enabled = qualityModeToggle.checked;

      // Update visual state
      if (qualityModeSection) {
        qualityModeSection.classList.toggle('active', enabled);
      }
      if (qualityModeStatus) {
        qualityModeStatus.style.display = enabled ? 'block' : 'none';
      }

      // Save setting
      const settings = await getSettings();
      settings.qualityMode = enabled;
      await chrome.storage.local.set({ settings });

      // Notify all tabs to refresh their blur state
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'QUALITY_MODE_CHANGED', enabled });
          } catch {
            // Tab might not have content script
          }
        }
      }
    });
  }

  // Blur Until Scored toggle
  const blurUntilScoredToggle = document.getElementById('blur-until-scored-toggle') as HTMLInputElement;
  if (blurUntilScoredToggle) {
    blurUntilScoredToggle.addEventListener('change', saveSettings);
  }
  document.getElementById('blur-until-scored-timeout')?.addEventListener('change', saveSettings);

  // Opaque Blur toggle
  const opaqueBlurToggle = document.getElementById('opaque-blur-toggle') as HTMLInputElement;
  if (opaqueBlurToggle) {
    opaqueBlurToggle.addEventListener('change', saveSettings);
  }
  document.getElementById('hover-reveal')?.addEventListener('change', saveSettings);
  document.getElementById('hide-blurred-badges')?.addEventListener('change', saveSettings);
  document.getElementById('hide-blurred-youtube')?.addEventListener('change', saveSettings);

  // API Tier selection
  const tierRadios = document.querySelectorAll('input[name="api-tier"]');
  const ownKeySection = document.getElementById('own-key-section');
  const tierFreeLabel = document.getElementById('tier-free-label');
  const tierOwnKeyLabel = document.getElementById('tier-own-key-label');

  tierRadios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const tier = target.value;

      // Toggle own-key section visibility
      if (ownKeySection) {
        ownKeySection.style.display = tier === 'own-key' ? 'flex' : 'none';
      }

      // Update label styling
      if (tierFreeLabel) {
        tierFreeLabel.style.borderColor = tier === 'free' ? '#3d2d4a' : '#333';
        tierFreeLabel.style.background = tier === 'free' ? '#2a2a3a' : '#222';
      }
      if (tierOwnKeyLabel) {
        tierOwnKeyLabel.style.borderColor = tier === 'own-key' ? '#3d2d4a' : '#333';
        tierOwnKeyLabel.style.background = tier === 'own-key' ? '#2a2a3a' : '#222';
      }

      await saveSettings();
    });
  });

  // Settings auto-save
  const apiKeyInput = document.getElementById('api-key');
  const apiSampleRateInput = document.getElementById('api-sample-rate');
  const ratioInput = document.getElementById('engagement-ratio');
  const cooldownInput = document.getElementById('cooldown-posts');
  const rescueTimeInput = document.getElementById('rescuetime-key');
  const todoistInput = document.getElementById('todoist-url');
  const jobSearchInput = document.getElementById('job-search-link');

  if (apiKeyInput) {
    apiKeyInput.addEventListener('change', saveSettings);
  }
  if (apiSampleRateInput) {
    apiSampleRateInput.addEventListener('change', saveSettings);
  }
  if (ratioInput) {
    ratioInput.addEventListener('change', saveSettings);
  }
  if (cooldownInput) {
    cooldownInput.addEventListener('change', saveSettings);
  }
  if (rescueTimeInput) {
    rescueTimeInput.addEventListener('change', saveSettings);
  }
  if (todoistInput) {
    todoistInput.addEventListener('change', saveSettings);
  }
  if (jobSearchInput) {
    jobSearchInput.addEventListener('change', saveSettings);
  }

  // Platform toggles
  for (const [id, name] of [
    ['platform-reddit', 'Reddit'],
    ['platform-twitter', 'Twitter'],
    ['platform-youtube', 'YouTube'],
    ['platform-instagram', 'Instagram'],
    ['platform-facebook', 'Facebook'],
  ]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    input?.addEventListener('change', async () => {
      await saveSettings();
      if (input.checked) {
        const offer = document.getElementById('turn-down-offer');
        if (offer) offer.style.display = 'none';
      } else {
        await offerTurnDown(input, name);
      }
    });
  }

  // Provider type toggle
  const providerTypeSelect = document.getElementById('provider-type') as HTMLSelectElement;
  const customEndpointSection = document.getElementById('custom-endpoint-section');
  if (providerTypeSelect && customEndpointSection) {
    providerTypeSelect.addEventListener('change', () => {
      const isCustom = providerTypeSelect.value === 'openai-compatible';
      customEndpointSection.style.display = isCustom ? 'block' : 'none';
      saveSettings();
    });
  }

  // Custom endpoint inputs
  const customEndpointInput = document.getElementById('custom-endpoint');
  const customApiKeyInput = document.getElementById('custom-api-key');
  const customTextModelInput = document.getElementById('custom-text-model');
  const customVisionModelInput = document.getElementById('custom-vision-model');
  const trackCostsInput = document.getElementById('track-costs') as HTMLInputElement;
  const trackCostsStatus = document.getElementById('track-costs-status');

  // A provider's address is an optional site: ask the browser for it when it is entered.
  // (Test Connection asks too, in case this change didn't count as a user action.)
  if (customEndpointInput) customEndpointInput.addEventListener('change', () => {
    requestEndpointAccess((customEndpointInput as HTMLInputElement).value).then(() => saveSettings());
  });
  if (customApiKeyInput) customApiKeyInput.addEventListener('change', saveSettings);
  if (customTextModelInput) customTextModelInput.addEventListener('change', saveSettings);
  if (customVisionModelInput) customVisionModelInput.addEventListener('change', saveSettings);
  if (trackCostsInput) {
    trackCostsInput.addEventListener('change', () => {
      if (trackCostsStatus) {
        trackCostsStatus.textContent = trackCostsInput.checked ? 'Enabled' : 'Disabled';
        trackCostsStatus.style.color = trackCostsInput.checked ? '#7dcea0' : '#888';
      }
      saveSettings();
    });
  }

  // Test endpoint button
  const testEndpointBtn = document.getElementById('test-endpoint-btn');
  if (testEndpointBtn) {
    testEndpointBtn.addEventListener('click', testEndpoint);
  }

  const proSubscriptionBtn = document.getElementById('pro-subscription-btn');
  if (proSubscriptionBtn) {
    proSubscriptionBtn.addEventListener('click', openProSubscription);
  }

  // Productivity card toggle
  const productivityCardEnabled = document.getElementById('productivity-card-enabled') as HTMLInputElement;
  if (productivityCardEnabled) {
    productivityCardEnabled.addEventListener('change', () => {
      const statusEl = document.getElementById('productivity-card-status');
      if (statusEl) {
        statusEl.textContent = productivityCardEnabled.checked ? 'Enabled' : 'Disabled';
        statusEl.style.color = productivityCardEnabled.checked ? '#7dcea0' : '#888';
      }
      saveSettings();
    });
  }

  // Claude filter toggle
  // claude.ai is an optional site: switching a Claude feature on asks the browser for
  // access, and switching the last one off gives it back
  const claudeInputs = ['claude-filter-enabled', 'claude-hide-streaming']
    .map(id => document.getElementById(id) as HTMLInputElement | null)
    .filter((input): input is HTMLInputElement => !!input);
  for (const input of claudeInputs) {
    input.addEventListener('change', () => {
      // Asked first, before anything is awaited: the prompt only shows straight from the user's action
      const access = input.checked ? requestAccess(CLAUDE_SITE.origins) : Promise.resolve(true);
      access.then(async granted => {
        if (!granted) input.checked = false;
        if (!claudeInputs.some(i => i.checked)) await removeAccess(CLAUDE_SITE.origins);
        await refreshClaudeStatus();
        saveSettings();
      });
    });
  }

  // TikTok is an optional site too. There is no setting behind this switch: it shows
  // whether the browser grants TikTok, and the time counter runs while it does.
  const tiktokInput = document.getElementById('platform-tiktok') as HTMLInputElement | null;
  if (tiktokInput) {
    hasAccess(TIKTOK_SITE.origins).then(granted => { tiktokInput.checked = granted; });
    tiktokInput.addEventListener('change', () => {
      const change = tiktokInput.checked ? requestAccess(TIKTOK_SITE.origins) : removeAccess(TIKTOK_SITE.origins);
      change.then(async () => { tiktokInput.checked = await hasAccess(TIKTOK_SITE.origins); });
    });
  }

  // Claude filter threshold sliders - live update display
  const claudeThresholdSliders = ['claude-skip', 'claude-gentle', 'claude-medium', 'claude-strong'];
  for (const id of claudeThresholdSliders) {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueEl = document.getElementById(`${id}-value`);
    if (slider && valueEl) {
      slider.addEventListener('input', () => {
        valueEl.textContent = slider.value;
      });
      slider.addEventListener('change', saveSettings);
    }
  }

  // Whitelist management
  const addWhitelistBtn = document.getElementById('add-whitelist-btn');
  if (addWhitelistBtn) {
    addWhitelistBtn.addEventListener('click', addWhitelistEntry);
  }

  // Whitelist delete buttons (delegated)
  const whitelistList = document.getElementById('whitelist-list');
  if (whitelistList) {
    whitelistList.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('remove-whitelist-btn')) {
        const sourceId = target.dataset.source;
        const platform = target.dataset.platform as WhitelistEntry['platform'];
        if (sourceId && platform) {
          await removeWhitelistEntry(sourceId, platform);
        }
      }
    });
  }

  // Blur settings - use 'input' for live update and 'change' for save
  const hoverDelayInput = document.getElementById('hover-delay') as HTMLInputElement;
  const hoverDelayValue = document.getElementById('hover-delay-value');
  const blurIntensityInput = document.getElementById('blur-intensity') as HTMLInputElement;
  const blurIntensityValue = document.getElementById('blur-intensity-value');

  if (hoverDelayInput) {
    hoverDelayInput.addEventListener('input', () => {
      if (hoverDelayValue) hoverDelayValue.textContent = hoverDelayInput.value;
    });
    hoverDelayInput.addEventListener('change', saveSettings);
  }

  if (blurIntensityInput) {
    blurIntensityInput.addEventListener('input', () => {
      if (blurIntensityValue) blurIntensityValue.textContent = blurIntensityInput.value;
    });
    blurIntensityInput.addEventListener('change', saveSettings);
  }

  // Log level selector
  const logLevelSelect = document.getElementById('log-level') as HTMLSelectElement;
  if (logLevelSelect) {
    logLevelSelect.addEventListener('change', saveSettings);
  }

  // Store post content toggle
  const storePostContentInput = document.getElementById('store-post-content') as HTMLInputElement;
  if (storePostContentInput) {
    storePostContentInput.addEventListener('change', () => {
      const statusEl = document.getElementById('store-post-content-status');
      if (statusEl) {
        statusEl.textContent = storePostContentInput.checked ? 'Enabled' : 'Disabled';
        statusEl.style.color = storePostContentInput.checked ? '#7dcea0' : '#888';
      }
      saveSettings();
    });
  }

  // Test boredom slider - saves to separate storage key for testing
  const testBoredomInput = document.getElementById('test-boredom') as HTMLInputElement;
  const testBoredomValue = document.getElementById('test-boredom-value');

  if (testBoredomInput) {
    // Load current value
    chrome.storage.local.get('testBoredomMinutes').then((result) => {
      const val = result.testBoredomMinutes || 0;
      testBoredomInput.value = String(val);
      if (testBoredomValue) testBoredomValue.textContent = String(val);
    });

    testBoredomInput.addEventListener('input', () => {
      if (testBoredomValue) testBoredomValue.textContent = testBoredomInput.value;
    });
    testBoredomInput.addEventListener('change', async () => {
      const minutes = parseInt(testBoredomInput.value || '0', 10);
      await chrome.storage.local.set({ testBoredomMinutes: minutes });
      console.log('Test boredom set to', minutes, 'minutes');
      // Refresh the global session display
      await loadGlobalSession();
    });
  }
}

// Status beside the Claude filter switch, including the case where a Claude feature is
// on but the browser no longer grants claude.ai (e.g. the user revoked it)
async function refreshClaudeStatus(): Promise<void> {
  const statusEl = document.getElementById('claude-filter-status');
  const filterOn = (document.getElementById('claude-filter-enabled') as HTMLInputElement | null)?.checked ?? false;
  const hideOn = (document.getElementById('claude-hide-streaming') as HTMLInputElement | null)?.checked ?? false;
  if (!statusEl) return;
  if ((filterOn || hideOn) && !(await hasAccess(CLAUDE_SITE.origins))) {
    statusEl.textContent = 'Needs access to claude.ai: switch off and on again';
    statusEl.style.color = '#e67e22';
    return;
  }
  statusEl.textContent = filterOn ? 'Enabled' : 'Disabled';
  statusEl.style.color = filterOn ? '#7dcea0' : '#888';
}

async function saveSettings(): Promise<void> {
  const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
  const apiSampleRateInput = document.getElementById('api-sample-rate') as HTMLInputElement;
  const ratioInput = document.getElementById('engagement-ratio') as HTMLInputElement;
  const cooldownInput = document.getElementById('cooldown-posts') as HTMLInputElement;
  const rescueTimeInput = document.getElementById('rescuetime-key') as HTMLInputElement;
  const todoistInput = document.getElementById('todoist-url') as HTMLInputElement;
  const jobSearchInput = document.getElementById('job-search-link') as HTMLInputElement;
  const hoverDelayInput = document.getElementById('hover-delay') as HTMLInputElement;
  const blurIntensityInput = document.getElementById('blur-intensity') as HTMLInputElement;
  const platformRedditInput = document.getElementById('platform-reddit') as HTMLInputElement;
  const platformTwitterInput = document.getElementById('platform-twitter') as HTMLInputElement;
  const platformYoutubeInput = document.getElementById('platform-youtube') as HTMLInputElement;
  const platformInstagramInput = document.getElementById('platform-instagram') as HTMLInputElement;
  const productivityCardEnabledInput = document.getElementById('productivity-card-enabled') as HTMLInputElement;
  const claudeFilterEnabledInput = document.getElementById('claude-filter-enabled') as HTMLInputElement;
  const claudeHideStreamingInput = document.getElementById('claude-hide-streaming') as HTMLInputElement;
  const claudeSkipInput = document.getElementById('claude-skip') as HTMLInputElement;
  const claudeGentleInput = document.getElementById('claude-gentle') as HTMLInputElement;
  const claudeMediumInput = document.getElementById('claude-medium') as HTMLInputElement;
  const claudeStrongInput = document.getElementById('claude-strong') as HTMLInputElement;
  const logLevelSelect = document.getElementById('log-level') as HTMLSelectElement;
  const blurUntilScoredInput = document.getElementById('blur-until-scored-toggle') as HTMLInputElement;
  const opaqueBlurInput = document.getElementById('opaque-blur-toggle') as HTMLInputElement;
  const platformFacebookInput = document.getElementById('platform-facebook') as HTMLInputElement;

  // API tier selection
  const tierRadio = document.querySelector('input[name="api-tier"]:checked') as HTMLInputElement;
  const apiTier = (tierRadio?.value || 'free') as 'free' | 'own-key';

  // Provider configuration inputs
  const providerTypeSelect = document.getElementById('provider-type') as HTMLSelectElement;
  const customEndpointInput = document.getElementById('custom-endpoint') as HTMLInputElement;
  const customApiKeyInput = document.getElementById('custom-api-key') as HTMLInputElement;
  const customTextModelInput = document.getElementById('custom-text-model') as HTMLInputElement;
  const customVisionModelInput = document.getElementById('custom-vision-model') as HTMLInputElement;
  const trackCostsInput = document.getElementById('track-costs') as HTMLInputElement;

  // Get existing settings to merge
  const existing = await getSettings();

  // Convert 0-100 to 0-1
  const sampleRatePercent = parseInt(apiSampleRateInput?.value || '10', 10);
  const apiSampleRate = Math.max(0, Math.min(100, sampleRatePercent)) / 100;

  // Build provider config
  const providerType = (providerTypeSelect?.value || 'openrouter') as 'openrouter' | 'openai-compatible';
  const visionModel = customVisionModelInput?.value?.trim();

  const settings: Settings = {
    ...existing,
    apiTier,
    apiProvider: {
      type: providerType,
      endpoint: providerType === 'openai-compatible' ? (customEndpointInput?.value?.trim() || undefined) : undefined,
      textModel: customTextModelInput?.value?.trim() || undefined,
      imageModel: visionModel || undefined,
      visionMode: visionModel ? 'enabled' : 'disabled',
      trackCosts: trackCostsInput?.checked ?? true,
    },
    apiSampleRate,
    platforms: {
      reddit: platformRedditInput?.checked ?? true,
      twitter: platformTwitterInput?.checked ?? true,
      youtube: platformYoutubeInput?.checked ?? true,
      instagram: platformInstagramInput?.checked ?? true,
      facebook: platformFacebookInput?.checked ?? true,
    },
    scheduler: {
      ...existing.scheduler, // Preserve progressive boredom settings
      highEngagementRatio: parseFloat(ratioInput?.value || '0.2'),
      cooldownPosts: parseInt(cooldownInput?.value || String(DEFAULT_BLUR_UNTIL_SCORED_TIMEOUT), 10),
      enabled: true,
    },
    productivityCardEnabled: productivityCardEnabledInput?.checked ?? false,
    claudeFilterEnabled: claudeFilterEnabledInput?.checked ?? false,
    claudeFilterHideWhileStreaming: claudeHideStreamingInput?.checked ?? false,
    claudeFilterThresholds: {
      skipFilter: parseInt(claudeSkipInput?.value || '30', 10),
      gentleReminder: parseInt(claudeGentleInput?.value || '30', 10),
      mediumReminder: parseInt(claudeMediumInput?.value || '60', 10),
      strongReminder: parseInt(claudeStrongInput?.value || '90', 10),
    },
    todoistUrl: todoistInput?.value || undefined,
    jobSearchLink: jobSearchInput?.value || undefined,
    twitter: {
      ...existing.twitter, // Preserve existing twitter settings
      // Settings saved before these two existed don't have them: fill in the defaults
      reorderEnabled: existing.twitter?.reorderEnabled ?? false,
      blurHighEngagement: existing.twitter?.blurHighEngagement ?? true,
      hoverRevealDelay: parseInt(hoverDelayInput?.value || '3', 10),
      blurIntensity: parseInt(blurIntensityInput?.value || '8', 10),
      opaqueBlur: opaqueBlurInput?.checked ?? true,
      hoverReveal: (document.getElementById('hover-reveal') as HTMLInputElement | null)?.checked ?? true,
      hideBlurredBadges: (document.getElementById('hide-blurred-badges') as HTMLInputElement | null)?.checked ?? false,
      hideBlurredYouTube: (document.getElementById('hide-blurred-youtube') as HTMLInputElement | null)?.checked ?? false,
    },
    logLevel: (logLevelSelect?.value as Settings['logLevel']) || 'error',
    blurUntilScored: blurUntilScoredInput?.checked ?? true,
    blurUntilScoredTimeout: parseInt((document.getElementById('blur-until-scored-timeout') as HTMLSelectElement | null)?.value || String(DEFAULT_BLUR_UNTIL_SCORED_TIMEOUT), 10),
    calibration: {
      ...existing.calibration,
      storeApiReason: existing.calibration?.storeApiReason ?? true,
      storePostContent: (document.getElementById('store-post-content') as HTMLInputElement)?.checked ?? false,
    },
  };

  // Keys go to their own store, never into the settings object: content scripts on
  // every site can read the settings
  // (only for fields that are on the page: a missing field must not erase its key)
  await setSecrets({
    ...(apiKeyInput && { openRouterApiKey: apiKeyInput.value.trim() }),
    ...(customApiKeyInput && { customApiKey: customApiKeyInput.value.trim() }),
    ...(rescueTimeInput && { rescueTimeApiKey: rescueTimeInput.value.trim() }),
  });
  await chrome.storage.local.set({ settings: withoutSecrets(settings) });
  console.log('Settings saved, apiSampleRate:', apiSampleRate, 'hoverDelay:', settings.twitter?.hoverRevealDelay);

  // Update API status display
  await updateApiStatus(settings);
}

async function exportData(): Promise<void> {
  try {
    // Read IndexedDB directly (the dashboard shares the extension origin).
    // Routing this through runtime messaging hits Chrome's 64 MiB message cap.
    const [sessions, calibration, postContent, usageResult] = await Promise.all([
      getAllSessions(),
      getCalibrationData(),
      getAllPostContent(),
      chrome.runtime.sendMessage({ type: 'GET_API_USAGE' }) as Promise<{ usage?: ApiUsage } | null>,
    ]);

    // Build the file from per-record chunks rather than one giant string,
    // so export size isn't bounded by the max JS string length
    const parts: string[] = [];
    const writeArray = (key: string, items: unknown[], last = false) => {
      parts.push(`  "${key}": [`);
      items.forEach((item, i) => {
        parts.push((i === 0 ? '\n    ' : ',\n    ') + JSON.stringify(item));
      });
      parts.push(items.length ? '\n  ]' : ']');
      parts.push(last ? '\n' : ',\n');
    };

    parts.push('{\n');
    parts.push(`  "exportDate": ${JSON.stringify(new Date().toISOString())},\n`);
    parts.push(`  "apiUsage": ${JSON.stringify(usageResult?.usage ?? null)},\n`);
    parts.push(`  "extensionVersion": ${JSON.stringify(chrome.runtime.getManifest().version)},\n`);
    parts.push(`  "scoringSpecVersion": ${SCORING_SPEC_VERSION},\n`);
    // The small records kept outside IndexedDB: minutes per day, topic tallies, the
    // daily feedback answers, and topic names (sessions refer to topics by id).
    // Settings are left out on purpose: they hold API keys.
    const kept = await chrome.storage.local.get<{
      usageHistory?: Record<string, number>;
      globalSession?: { resetDate: string; totalMinutes: number };
      yesterdaySession?: { date: string; minutes: number };
      topicHits?: unknown;
      adaptiveSettings?: unknown;
      narrativeThemes?: NarrativeTheme[];
    }>(['usageHistory', 'globalSession', 'yesterdaySession', 'topicHits', 'adaptiveSettings', 'narrativeThemes']);
    const minutesByDay: Record<string, number> = { ...kept.usageHistory };
    if (kept.yesterdaySession) minutesByDay[kept.yesterdaySession.date] ??= kept.yesterdaySession.minutes;
    if (kept.globalSession) minutesByDay[kept.globalSession.resetDate] = kept.globalSession.totalMinutes;
    parts.push(`  "minutesByDay": ${JSON.stringify(minutesByDay)},\n`);
    parts.push(`  "topicHits": ${JSON.stringify(kept.topicHits ?? {})},\n`);
    parts.push(`  "adaptiveSettings": ${JSON.stringify(kept.adaptiveSettings ?? null)},\n`);
    parts.push(`  "topics": ${JSON.stringify((kept.narrativeThemes ?? []).map(t => ({ id: t.id, name: t.name })))},\n`);
    writeArray('sessions', sessions);
    writeArray('calibration', calibration);
    writeArray('postContent', postContent, true);
    parts.push('}\n');

    const blob = new Blob(parts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `tolerance-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    // Give the download a moment to start before releasing the blob
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Export failed. See console for details.');
  }
}

async function toggleBaselineMode(): Promise<void> {
  try {
    const state = await getState();

    if (state.mode === 'baseline') {
      // Exit baseline mode
      if (!confirm('Exit baseline mode? The extension will start reordering your feed.')) {
        return;
      }
      state.mode = 'active';
      console.log('Baseline mode ended, now in active mode');
    } else {
      // Enter baseline mode
      if (!confirm('Enter baseline mode? The extension will stop reordering and just collect data.')) {
        return;
      }
      state.mode = 'baseline';
      state.baselineStartDate = Date.now();
      console.log('Entered baseline mode');
    }

    await chrome.storage.local.set({ state });
    updateModeDisplay(state);
  } catch (error) {
    console.error('Failed to toggle baseline mode:', error);
    alert('Failed to toggle mode. See console for details.');
  }
}

async function clearData(): Promise<void> {
  if (!confirm('Are you sure you want to clear all data? This cannot be undone.')) {
    return;
  }

  try {
    // The history itself lives in the database. This used to clear only the small
    // settings storage and report success, leaving every session, score and stored
    // post in place.
    await clearAllStores();
    // The install keeps its identity and free key, so clearing doesn't mint a new one
    const keep = await chrome.storage.local.get(['installId', 'researchConsent']);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(keep);
    // The person's own keys go too; the free key issued to this install stays
    await setSecrets({ openRouterApiKey: undefined, customApiKey: undefined, rescueTimeApiKey: undefined });
    alert('All data and settings cleared.');
    // Reload so the controls show the cleared state; left as they were, the next
    // change would save the old values (including the API key) straight back
    location.reload();
  } catch (error) {
    console.error('Clear failed:', error);
    alert('Clear failed. See console for details.');
  }
}

// ==========================================
// Narrative Awareness Functions
// ==========================================

let currentNarrativeThemes: NarrativeTheme[] = [];
let currentTrendDays = 1;
let editingStrategyId: string | null = null;

async function loadNarrativeData(): Promise<void> {
  try {
    // Load themes
    const themesResult = await chrome.runtime.sendMessage({ type: 'GET_NARRATIVE_THEMES' }) as {
      themes: NarrativeTheme[];
    } | null;
    currentNarrativeThemes = themesResult?.themes || [];

    // Render themes list
    renderThemesList(currentNarrativeThemes);

    // Load trends
    await loadNarrativeTrends(currentTrendDays);

    // Load counter-strategies
    await loadCounterStrategies();

    // Set up narrative event listeners
    setupNarrativeEventListeners();
  } catch (error) {
    console.error('Failed to load narrative data:', error);
  }
}

// ==========================================
// Theme Management Functions
// ==========================================

let editingThemeId: string | null = null;

function renderThemesList(themes: NarrativeTheme[]): void {
  const container = document.getElementById('themes-list');
  if (!container) return;

  if (themes.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No narratives configured.</div>';
    return;
  }

  // Sort: active first, then by name
  const sortedThemes = [...themes].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  container.innerHTML = sortedThemes.map(theme => {
    const isSystem = theme.isSystemTheme;
    const isActive = theme.active;
    const description = theme.description || '(No description)';
    const isLongDesc = description.length > 150;

    return `
      <div class="theme-item ${isActive ? '' : 'inactive'} ${isSystem ? 'system-theme' : ''}" data-id="${theme.id}">
        <div class="theme-info">
          <div class="theme-header">
            <span class="theme-name">${escapeHtml(theme.name)}</span>
            <span class="theme-badge ${isSystem ? 'system' : 'custom'}">${isSystem ? 'System' : 'Custom'}</span>
            ${!isActive ? '<span class="theme-badge inactive-badge">Inactive</span>' : ''}
          </div>
          <div class="theme-description" data-full="${escapeHtml(description)}">${escapeHtml(description.slice(0, 150))}${isLongDesc ? '...' : ''}</div>
          ${isLongDesc ? '<button class="theme-expand-btn" data-id="' + theme.id + '">Show more</button>' : ''}
        </div>
        <div class="theme-actions">
          <div class="theme-toggle ${isActive ? 'active' : ''}" data-id="${theme.id}" title="${isActive ? 'Click to disable' : 'Click to enable'}"></div>
          ${!isSystem ? `
            <div class="theme-action-btns">
              <button class="edit-theme-btn" data-id="${theme.id}">Edit</button>
              <button class="delete-btn delete-theme-btn" data-id="${theme.id}">Delete</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Set up event listeners for theme actions
  setupThemeEventListeners();
}

function setupThemeEventListeners(): void {
  const container = document.getElementById('themes-list');
  if (!container) return;

  // Toggle active state
  container.querySelectorAll('.theme-toggle').forEach(toggle => {
    toggle.addEventListener('click', async (e) => {
      const target = e.currentTarget as HTMLElement;
      const themeId = target.dataset.id;
      if (themeId) {
        await toggleThemeActive(themeId);
      }
    });
  });

  // Expand description
  container.querySelectorAll('.theme-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const themeItem = target.closest('.theme-item');
      const descEl = themeItem?.querySelector('.theme-description') as HTMLElement;
      if (descEl) {
        const isExpanded = descEl.classList.contains('expanded');
        if (isExpanded) {
          descEl.classList.remove('expanded');
          const fullText = descEl.dataset.full || '';
          descEl.textContent = fullText.slice(0, 150) + (fullText.length > 150 ? '...' : '');
          target.textContent = 'Show more';
        } else {
          descEl.classList.add('expanded');
          descEl.textContent = descEl.dataset.full || '';
          target.textContent = 'Show less';
        }
      }
    });
  });

  // Edit theme
  container.querySelectorAll('.edit-theme-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const themeId = target.dataset.id;
      if (themeId) {
        openEditThemeModal(themeId);
      }
    });
  });

  // Delete theme
  container.querySelectorAll('.delete-theme-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const themeId = target.dataset.id;
      if (themeId) {
        const theme = currentNarrativeThemes.find(t => t.id === themeId);
        if (theme && confirm(`Delete topic "${theme.name}"?\n\nThis will also delete any blur adjustment using this topic. This cannot be undone.`)) {
          await deleteTheme(themeId);
        }
      }
    });
  });
}

async function toggleThemeActive(themeId: string): Promise<void> {
  const theme = currentNarrativeThemes.find(t => t.id === themeId);
  if (!theme) return;

  const updatedTheme: NarrativeTheme = {
    ...theme,
    active: !theme.active,
  };

  try {
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme: updatedTheme });
    // Refresh the list
    await loadNarrativeData();
    console.log(`Narrative "${theme.name}" ${updatedTheme.active ? 'activated' : 'deactivated'}`);
  } catch (error) {
    console.error('Failed to toggle narrative:', error);
    alert('Failed to update narrative. Please try again.');
  }
}

async function deleteTheme(themeId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'DELETE_NARRATIVE_THEME', themeId });
    // Refresh the list
    await loadNarrativeData();
    console.log('Narrative deleted:', themeId);
  } catch (error) {
    console.error('Failed to delete narrative:', error);
    alert('Failed to delete narrative. Please try again.');
  }
}

function openEditThemeModal(themeId: string): void {
  const theme = currentNarrativeThemes.find(t => t.id === themeId);
  if (!theme) return;

  editingThemeId = themeId;

  const modal = document.getElementById('edit-theme-modal');
  const nameInput = document.getElementById('edit-theme-name') as HTMLInputElement;
  const descInput = document.getElementById('edit-theme-desc') as HTMLTextAreaElement;

  if (modal && nameInput && descInput) {
    nameInput.value = theme.name;
    descInput.value = theme.description || '';
    modal.style.display = 'flex';
  }
}

function closeEditThemeModal(): void {
  const modal = document.getElementById('edit-theme-modal');
  if (modal) modal.style.display = 'none';
  editingThemeId = null;
}

async function saveEditedTheme(): Promise<void> {
  if (!editingThemeId) return;

  const theme = currentNarrativeThemes.find(t => t.id === editingThemeId);
  if (!theme) return;

  const nameInput = document.getElementById('edit-theme-name') as HTMLInputElement;
  const descInput = document.getElementById('edit-theme-desc') as HTMLTextAreaElement;

  const name = nameInput?.value?.trim();
  const description = descInput?.value?.trim();

  if (!name) {
    alert('Please enter a narrative name');
    return;
  }
  if (!description) {
    alert('Please enter a description. This is how the AI identifies matching content.');
    return;
  }

  const updatedTheme: NarrativeTheme = {
    ...theme,
    name,
    description,
  };

  try {
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme: updatedTheme });
    closeEditThemeModal();
    await loadNarrativeData();
    console.log('Narrative updated:', name);
  } catch (error) {
    console.error('Failed to update narrative:', error);
    alert('Failed to update narrative. Please try again.');
  }
}

async function loadNarrativeTrends(days: number): Promise<void> {
  currentTrendDays = days;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_NARRATIVE_TRENDS', days }) as {
      trends: DailyNarrativeStats[];
    } | null;

    const trends = result?.trends || [];
    renderNarrativeTrends(trends);
  } catch (error) {
    console.error('Failed to load narrative trends:', error);
  }
}

function renderNarrativeTrends(trends: DailyNarrativeStats[]): void {
  const container = document.getElementById('narrative-bars');
  const alertEl = document.getElementById('narrative-alert');
  if (!container) return;

  // Get the latest day's data
  const today = trends.length > 0 ? trends[trends.length - 1] : null;

  if (!today || today.totalPosts === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">Nothing yet. Browse Reddit to start tracking.</div>';
    if (alertEl) alertEl.style.display = 'none';
    return;
  }

  // Check for spikes (2x baseline)
  const spikes: string[] = [];
  for (const [themeId, exposure] of Object.entries(today.exposure)) {
    const baseline = today.baselineAvg?.[themeId] || 0;
    if (baseline > 0 && exposure > baseline * 2) {
      const theme = currentNarrativeThemes.find(t => t.id === themeId);
      spikes.push(`${theme?.name || themeId} is ${(exposure / baseline).toFixed(1)}x baseline`);
    }
  }

  // Show alert if spikes detected
  if (alertEl) {
    if (spikes.length > 0) {
      alertEl.style.display = 'block';
      alertEl.innerHTML = `<strong>Alert:</strong> ${escapeHtml(spikes.join(', '))}`;
    } else {
      alertEl.style.display = 'none';
    }
  }

  // Get theme colors
  const themeColors: Record<string, string> = {
    doom: 'bar-doom',
    conspiracy: 'bar-conspiracy',
    identity: 'bar-identity',
  };

  // Render bars for each theme
  const bars: string[] = [];
  for (const theme of currentNarrativeThemes) {
    if (!theme.active) continue;

    const exposure = today.exposure[theme.id] || 0;
    const baseline = today.baselineAvg?.[theme.id] || 0;
    const colorClass = themeColors[theme.id] || 'bar-user';

    bars.push(`
      <div class="narrative-bar-row">
        <span class="narrative-label" title="${escapeHtml(theme.name)}">${escapeHtml(theme.name)}</span>
        <div class="narrative-bar-container">
          <div class="narrative-bar ${colorClass}" style="width: ${Math.min(100, exposure)}%"></div>
          ${baseline > 0 ? `<div class="baseline-marker" style="left: ${Math.min(100, baseline)}%"></div>` : ''}
        </div>
        <span class="narrative-value">${exposure}%</span>
      </div>
    `);
  }

  if (bars.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No active narratives.</div>';
  } else {
    container.innerHTML = bars.join('');
  }
}

async function loadCounterStrategies(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_COUNTER_STRATEGIES' }) as {
      strategies: CounterStrategy[];
    } | null;

    renderCounterStrategies(result?.strategies || []);
    await renderTopics(currentNarrativeThemes, result?.strategies || []);
  } catch (error) {
    console.error('Failed to load counter-strategies:', error);
  }
}

function renderCounterStrategies(strategies: CounterStrategy[]): void {
  const container = document.getElementById('strategies-list');
  if (!container) return;

  if (strategies.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No adjustments yet.</div>';
    return;
  }

  container.innerHTML = strategies.map(strategy => {
    const theme = currentNarrativeThemes.find(t => t.id === strategy.themeId);
    const modifierSign = strategy.scoreModifier >= 0 ? '+' : '';
    const modifierLabel = strategy.scoreModifier > 0 ? 'Suppress' : strategy.scoreModifier < 0 ? 'Surface' : 'No change';
    return `
      <div class="strategy-item" data-id="${strategy.id}">
        <div class="strategy-header">
          <span class="strategy-theme-badge">${escapeHtml(theme?.name || strategy.themeId)}</span>
          <div>
            <button class="btn-secondary strategy-toggle" data-id="${strategy.id}" data-enabled="${strategy.enabled}">
              ${strategy.enabled ? 'Enabled' : 'Disabled'}
            </button>
            <button class="btn-secondary edit-strategy-btn" data-id="${strategy.id}" style="margin-left: 4px;">Edit</button>
            <button class="btn-secondary delete-strategy-btn" data-id="${strategy.id}" style="margin-left: 4px;">Delete</button>
          </div>
        </div>
        <div class="strategy-dialectic">
          <div class="dialectic-col">
            <div class="dialectic-label">Thesis</div>
            <div class="dialectic-text">${escapeHtml(strategy.thesis.slice(0, 100))}${strategy.thesis.length > 100 ? '...' : ''}</div>
          </div>
          ${strategy.antithesis ? `
          <div class="dialectic-col">
            <div class="dialectic-label">Antithesis</div>
            <div class="dialectic-text">${escapeHtml(strategy.antithesis.slice(0, 100))}${strategy.antithesis.length > 100 ? '...' : ''}</div>
          </div>
          ` : ''}
          ${strategy.synthesis ? `
          <div class="dialectic-col">
            <div class="dialectic-label">Synthesis</div>
            <div class="dialectic-text">${escapeHtml(strategy.synthesis.slice(0, 100))}${strategy.synthesis.length > 100 ? '...' : ''}</div>
          </div>
          ` : ''}
        </div>
        <div class="strategy-meta">
          ${modifierLabel}: ${modifierSign}${strategy.scoreModifier} points
        </div>
      </div>
    `;
  }).join('');
}

// Called after every reload of the topic data, but the listeners must only be added
// once: stacked copies asked "Delete this adjustment?" several times over.
let narrativeListenersReady = false;
function setupNarrativeEventListeners(): void {
  if (narrativeListenersReady) return;
  narrativeListenersReady = true;
  // Time selector buttons
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const days = parseInt(target.dataset.days || '1', 10);

      // Update active state
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      await loadNarrativeTrends(days);
    });
  });

  // Strategy list event delegation
  document.getElementById('strategies-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    if (target.classList.contains('strategy-toggle')) {
      const id = target.dataset.id;
      const enabled = target.dataset.enabled === 'true';
      if (id) {
        await toggleStrategy(id, !enabled);
      }
    }

    if (target.classList.contains('edit-strategy-btn')) {
      const id = target.dataset.id;
      if (id) {
        await openStrategyModal(id);
      }
    }

    if (target.classList.contains('delete-strategy-btn')) {
      const id = target.dataset.id;
      if (id && confirm('Delete this adjustment?')) {
        await chrome.runtime.sendMessage({ type: 'DELETE_COUNTER_STRATEGY', strategyId: id });
        await loadCounterStrategies();
      }
    }
  });

  // Add strategy button
  document.getElementById('add-strategy-btn')?.addEventListener('click', () => {
    openStrategyModal(null);
  });

  // Strategy modal
  document.getElementById('cancel-strategy-btn')?.addEventListener('click', closeStrategyModal);
  document.getElementById('save-strategy-btn')?.addEventListener('click', saveStrategy);

  // Edit narrative modal
  document.getElementById('cancel-edit-theme-btn')?.addEventListener('click', closeEditThemeModal);
  document.getElementById('save-edit-theme-btn')?.addEventListener('click', saveEditedTheme);

  // Score modifier slider value display
  const modifierSlider = document.getElementById('strategy-modifier') as HTMLInputElement;
  const modifierValue = document.getElementById('modifier-value');
  if (modifierSlider && modifierValue) {
    modifierSlider.addEventListener('input', () => {
      const val = parseInt(modifierSlider.value, 10);
      modifierValue.textContent = val >= 0 ? `+${val}` : String(val);
    });
  }

  // Theme selector auto-fills thesis
  const themeSelect = document.getElementById('strategy-theme') as HTMLSelectElement;
  const thesisTextarea = document.getElementById('strategy-thesis') as HTMLTextAreaElement;
  if (themeSelect && thesisTextarea) {
    themeSelect.addEventListener('change', () => {
      const theme = currentNarrativeThemes.find(t => t.id === themeSelect.value);
      if (theme) {
        thesisTextarea.value = theme.description;
      }
    });
  }
}

async function toggleStrategy(id: string, enabled: boolean): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'GET_COUNTER_STRATEGIES' }) as {
    strategies: CounterStrategy[];
  } | null;

  const strategy = result?.strategies?.find(s => s.id === id);
  if (strategy) {
    strategy.enabled = enabled;
    await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy });
    await loadCounterStrategies();
  }
}

async function openStrategyModal(strategyId: string | null): Promise<void> {
  editingStrategyId = strategyId;
  const modal = document.getElementById('strategy-modal');
  if (!modal) return;

  // Populate theme dropdown
  const themeSelect = document.getElementById('strategy-theme') as HTMLSelectElement;
  if (themeSelect) {
    themeSelect.innerHTML = currentNarrativeThemes
      .filter(t => t.active)
      .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('');
  }

  // Get form elements
  const thesisEl = document.getElementById('strategy-thesis') as HTMLTextAreaElement;
  const antithesisEl = document.getElementById('strategy-antithesis') as HTMLTextAreaElement;
  const synthesisEl = document.getElementById('strategy-synthesis') as HTMLTextAreaElement;
  const modifierEl = document.getElementById('strategy-modifier') as HTMLInputElement;
  const modifierValueEl = document.getElementById('modifier-value');
  const dialecticalDetails = document.querySelector('.dialectical-section') as HTMLDetailsElement;

  if (strategyId) {
    // Edit existing strategy
    const result = await chrome.runtime.sendMessage({ type: 'GET_COUNTER_STRATEGIES' }) as {
      strategies: CounterStrategy[];
    } | null;
    const strategy = result?.strategies?.find(s => s.id === strategyId);

    if (strategy) {
      if (themeSelect) themeSelect.value = strategy.themeId;
      if (thesisEl) thesisEl.value = strategy.thesis;
      if (antithesisEl) antithesisEl.value = strategy.antithesis || '';
      if (synthesisEl) synthesisEl.value = strategy.synthesis || '';
      if (modifierEl) modifierEl.value = String(strategy.scoreModifier);
      if (modifierValueEl) {
        const val = strategy.scoreModifier;
        modifierValueEl.textContent = val >= 0 ? `+${val}` : String(val);
      }
      // Expand dialectical section if there's content
      if (dialecticalDetails && (strategy.antithesis || strategy.synthesis)) {
        dialecticalDetails.open = true;
      }
    }
  } else {
    // New strategy - auto-fill thesis from first theme
    const firstTheme = currentNarrativeThemes.find(t => t.active);
    if (thesisEl && firstTheme) thesisEl.value = firstTheme.description;
    if (antithesisEl) antithesisEl.value = '';
    if (synthesisEl) synthesisEl.value = '';
    if (modifierEl) modifierEl.value = '20';
    if (modifierValueEl) modifierValueEl.textContent = '+20';
    if (dialecticalDetails) dialecticalDetails.open = false;
  }

  modal.style.display = 'flex';
}

function closeStrategyModal(): void {
  const modal = document.getElementById('strategy-modal');
  if (modal) modal.style.display = 'none';
  editingStrategyId = null;
}

async function saveStrategy(): Promise<void> {
  const themeSelect = document.getElementById('strategy-theme') as HTMLSelectElement;
  const thesisEl = document.getElementById('strategy-thesis') as HTMLTextAreaElement;
  const antithesisEl = document.getElementById('strategy-antithesis') as HTMLTextAreaElement;
  const synthesisEl = document.getElementById('strategy-synthesis') as HTMLTextAreaElement;
  const modifierEl = document.getElementById('strategy-modifier') as HTMLInputElement;

  const antithesis = antithesisEl?.value?.trim() || '';
  const synthesis = synthesisEl?.value?.trim() || '';

  const strategy: CounterStrategy = {
    id: editingStrategyId || `strategy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    themeId: themeSelect?.value || '',
    thesis: thesisEl?.value || '',
    antithesis: antithesis || undefined,
    synthesis: synthesis || undefined,
    scoreModifier: parseInt(modifierEl?.value || '20', 10),
    enabled: true,
    createdAt: Date.now(),
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy });
  closeStrategyModal();
  await loadCounterStrategies();
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  // Quotes too: this is used inside attribute values, where an unescaped " cut the
  // value short (a trusted source with a quote in its name could not be removed)
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function testEndpoint(): Promise<void> {
  const btn = document.getElementById('test-endpoint-btn') as HTMLButtonElement;
  const statusEl = document.getElementById('test-endpoint-status');

  if (!btn || !statusEl) return;

  // Get current endpoint config from inputs
  const endpointInput = document.getElementById('custom-endpoint') as HTMLInputElement;
  const apiKeyInput = document.getElementById('custom-api-key') as HTMLInputElement;
  const textModelInput = document.getElementById('custom-text-model') as HTMLInputElement;

  const endpoint = endpointInput?.value?.trim();
  const apiKey = apiKeyInput?.value?.trim();
  const model = textModelInput?.value?.trim();

  if (!endpoint) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#4a2d2d';
    statusEl.style.color = '#ff9999';
    statusEl.textContent = 'Please enter an endpoint URL first.';
    return;
  }

  if (!model) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#4a2d2d';
    statusEl.style.color = '#ff9999';
    statusEl.textContent = 'Please enter a model name first.';
    return;
  }

  // Ask the browser for this address first, before anything is awaited (the prompt only
  // shows straight from the click). If it is declined the test still runs, and passes
  // only if the server accepts requests from browser extensions.
  const access = requestEndpointAccess(endpoint);

  // Update button state
  btn.disabled = true;
  btn.textContent = 'Testing...';
  statusEl.style.display = 'block';
  statusEl.style.background = '#2d3a4a';
  statusEl.style.color = '#99bbff';
  statusEl.textContent = 'Connecting to endpoint...';

  try {
    await access;
    const result = await chrome.runtime.sendMessage({
      type: 'TEST_ENDPOINT',
      endpoint,
      model: model || undefined,
      apiKey: apiKey || undefined,
    }) as {
      success: boolean;
      message: string;
      model?: string;
      responseTime?: number;
    };

    if (result.success) {
      statusEl.style.background = '#1a472a';
      statusEl.style.color = '#7dcea0';
      let successMsg = `Connected successfully!`;
      if (result.model) {
        successMsg += ` Model: ${result.model}`;
      }
      if (result.responseTime) {
        successMsg += ` (${result.responseTime}ms)`;
      }
      statusEl.textContent = successMsg;
    } else {
      statusEl.style.background = '#4a2d2d';
      statusEl.style.color = '#ff9999';
      statusEl.textContent = `Failed: ${result.message}`;
    }
  } catch (error) {
    statusEl.style.background = '#4a2d2d';
    statusEl.style.color = '#ff9999';
    statusEl.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }

  btn.disabled = false;
  btn.textContent = 'Test Connection';
}

document.addEventListener('DOMContentLoaded', async () => {
  await init();
  await loadNarrativeData();
});

// Load and display global session (progressive boredom) data
async function loadGlobalSession(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_GLOBAL_SESSION' }) as {
      globalSession: {
        startTimestamp: number;
        totalMinutes: number;
        lastHeartbeat: number;
        resetDate: string;
      };
      phase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
      settings: {
        progressiveBoredomEnabled: boolean;
        phaseThresholds: {
          normal: number;
          reduced: number;
          windDown: number;
        };
        phaseRatios: {
          normal: number;
          reduced: number;
          windDown: number;
          minimal: number;
        };
      };
    } | null;

    if (!result) {
      console.error('Failed to get global session data');
      return;
    }

    const { globalSession, phase, settings } = result;
    const minutes = globalSession.totalMinutes;

    // Update session time display
    const sessionTimeEl = document.getElementById('session-time');
    if (sessionTimeEl) {
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        sessionTimeEl.textContent = `${hours}h ${mins}m`;
      } else {
        sessionTimeEl.textContent = `${Math.round(minutes)}m`;
      }
    }

    // Update phase badge
    const phaseBadgeEl = document.getElementById('phase-badge');
    if (phaseBadgeEl) {
      const phaseLabels: Record<string, string> = {
        'normal': 'Normal',
        'reduced': 'Reduced',
        'wind-down': 'Wind Down',
        'minimal': 'Minimal',
      };
      phaseBadgeEl.textContent = phaseLabels[phase] || phase;
      phaseBadgeEl.className = `phase-indicator phase-${phase}`;
    }

    // Update progress bars
    const thresholds = settings.phaseThresholds;
    updateProgressBar('progress-normal', minutes, 0, thresholds.normal);
    updateProgressBar('progress-reduced', minutes, thresholds.normal, thresholds.reduced);
    updateProgressBar('progress-winddown', minutes, thresholds.reduced, thresholds.windDown);
    updateProgressBar('progress-minimal', minutes, thresholds.windDown, thresholds.windDown + 30); // 30 min segment for minimal

    // Update threshold labels
    const thresholdNormalEl = document.getElementById('threshold-normal');
    const thresholdReducedEl = document.getElementById('threshold-reduced');
    const thresholdWindDownEl = document.getElementById('threshold-winddown');

    if (thresholdNormalEl) thresholdNormalEl.textContent = `${thresholds.normal}m`;
    if (thresholdReducedEl) thresholdReducedEl.textContent = `${thresholds.reduced}m`;
    if (thresholdWindDownEl) thresholdWindDownEl.textContent = `${thresholds.windDown}m`;

    // Update effective ratio display
    const effectiveRatioEl = document.getElementById('effective-ratio');
    if (effectiveRatioEl) {
      const ratios = settings.phaseRatios;
      // The phase is named "wind-down" but its setting is keyed "windDown"
      const currentRatio = ratios[(phase === 'wind-down' ? 'windDown' : phase) as keyof typeof ratios] ?? 0.2;
      effectiveRatioEl.textContent = `${Math.round(currentRatio * 100)}%`;
    }
  } catch (error) {
    console.error('Failed to load global session:', error);
  }
}

function updateProgressBar(id: string, currentMinutes: number, segmentStart: number, segmentEnd: number): void {
  const el = document.getElementById(id);
  if (!el) return;

  // Calculate fill percentage for this segment
  if (currentMinutes <= segmentStart) {
    el.style.width = '0%';
  } else if (currentMinutes >= segmentEnd) {
    el.style.width = '100%';
  } else {
    const segmentDuration = segmentEnd - segmentStart;
    const filledAmount = currentMinutes - segmentStart;
    const percent = (filledAmount / segmentDuration) * 100;
    el.style.width = `${Math.round(percent)}%`;
  }
}

// ==========================================
// Threshold Controls
// ==========================================

function setupThresholdControls(): void {
  // Blur threshold sliders - both top card and settings section
  const blurSliders = ['blur-normal', 'blur-reduced', 'blur-winddown', 'blur-minimal'];

  for (const id of blurSliders) {
    // Settings section sliders
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueEl = document.getElementById(`${id}-value`);
    if (slider && valueEl) {
      slider.addEventListener('input', () => {
        const threshold = String(sliderThreshold(slider, 100));
        valueEl.textContent = threshold;
        // Sync to top card slider
        const topSlider = document.getElementById(`${id}-top`) as HTMLInputElement;
        const topValueEl = document.getElementById(`${id}-value-top`);
        if (topSlider) topSlider.value = slider.value;
        if (topValueEl) topValueEl.textContent = threshold;
      });
      slider.addEventListener('change', saveCustomThresholds);
    }

    // Top card sliders
    const topSlider = document.getElementById(`${id}-top`) as HTMLInputElement;
    const topValueEl = document.getElementById(`${id}-value-top`);
    if (topSlider && topValueEl) {
      topSlider.addEventListener('input', () => {
        const threshold = String(sliderThreshold(topSlider, 100));
        topValueEl.textContent = threshold;
        // Sync to settings section slider
        if (slider) slider.value = topSlider.value;
        if (valueEl) valueEl.textContent = threshold;
      });
      topSlider.addEventListener('change', saveCustomThresholds);
    }
  }

  // Phase timing sliders - live update display
  const timingSliders = ['timing-normal', 'timing-reduced', 'timing-winddown'];
  for (const id of timingSliders) {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueEl = document.getElementById(`${id}-value`);
    if (slider && valueEl) {
      slider.addEventListener('input', () => {
        valueEl.textContent = slider.value;
        const minutes = (sliderId: string) =>
          parseInt((document.getElementById(sliderId) as HTMLInputElement).value, 10);
        setPhaseTimeLabels({
          normal: minutes('timing-normal'),
          reduced: minutes('timing-reduced'),
          windDown: minutes('timing-winddown'),
        });
      });
      slider.addEventListener('change', saveCustomThresholds);
    }
  }

  // Reset button (top card)
  const resetBtnTop = document.getElementById('reset-thresholds-btn-top');
  if (resetBtnTop) {
    resetBtnTop.addEventListener('click', resetThresholdsToCalibrated);
  }
  // The large reset button lower down had no handler at all
  document.getElementById('quick-reset-btn')?.addEventListener('click', resetThresholdsToCalibrated);
}

async function saveCustomThresholds(): Promise<void> {
  const existing = await getSettings();

  // Read all slider values
  const slider = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const blurNormal = sliderThreshold(slider('blur-normal'), DEFAULT_BLUR_THRESHOLDS.normal);
  const blurReduced = sliderThreshold(slider('blur-reduced'), DEFAULT_BLUR_THRESHOLDS.reduced);
  const blurWinddown = sliderThreshold(slider('blur-winddown'), DEFAULT_BLUR_THRESHOLDS.windDown);
  const blurMinimal = sliderThreshold(slider('blur-minimal'), DEFAULT_BLUR_THRESHOLDS.minimal);

  const timingNormal = parseInt((document.getElementById('timing-normal') as HTMLInputElement)?.value || '15', 10);
  const timingReduced = parseInt((document.getElementById('timing-reduced') as HTMLInputElement)?.value || '45', 10);
  const timingWinddown = parseInt((document.getElementById('timing-winddown') as HTMLInputElement)?.value || '75', 10);

  // Update settings with custom thresholds
  const settings: Settings = {
    ...existing,
    customThresholds: {
      blurThresholds: {
        normal: blurNormal,
        reduced: blurReduced,
        windDown: blurWinddown,
        minimal: blurMinimal,
      },
      phaseTiming: {
        normal: timingNormal,
        reduced: timingReduced,
        windDown: timingWinddown,
      },
      enabled: true,
    },
    // Also update the scheduler phase thresholds to use custom timing
    scheduler: {
      ...existing.scheduler,
      phaseThresholds: {
        normal: timingNormal,
        reduced: timingReduced,
        windDown: timingWinddown,
      },
    },
  };

  await chrome.storage.local.set({ settings });
  console.log('Custom thresholds saved:', settings.customThresholds);
  void renderThresholdNow();

  // Update status display
  const statusEl = document.getElementById('custom-thresholds-status');
  if (statusEl) {
    statusEl.textContent = 'Using custom values';
    statusEl.style.color = '#f39c12';
  }
}

async function resetThresholdsToCalibrated(): Promise<void> {
  const existing = await getSettings();

  // Reset to calibrated defaults
  const defaultBlurThresholds = DEFAULT_BLUR_THRESHOLDS;
  const defaultPhaseTiming = { normal: 15, reduced: 45, windDown: 75 };

  const settings: Settings = {
    ...existing,
    customThresholds: {
      blurThresholds: defaultBlurThresholds,
      phaseTiming: defaultPhaseTiming,
      enabled: false,
    },
    scheduler: {
      ...existing.scheduler,
      phaseThresholds: defaultPhaseTiming,
    },
  };

  await chrome.storage.local.set({ settings });
  console.log('Thresholds reset to calibrated defaults');

  // Re-populate the sliders
  populateCustomThresholds(settings);

  // Update status display
  const statusEl = document.getElementById('custom-thresholds-status');
  if (statusEl) {
    statusEl.textContent = 'Using calibrated defaults';
    statusEl.style.color = '#666';
  }
}

// ==========================================
// Whitelist Management Functions
// ==========================================

const WHITELIST_OPEN_MAX = 5;

function renderWhitelist(whitelist: WhitelistEntry[]): void {
  const container = document.getElementById('whitelist-list');
  if (!container) return;

  // Start closed when the list is long; after that, leave it as the user set it
  const details = document.getElementById('whitelist-details') as HTMLDetailsElement | null;
  const summary = document.getElementById('whitelist-summary');
  if (summary) summary.textContent = `${whitelist.length} trusted ${whitelist.length === 1 ? 'source' : 'sources'}`;
  if (details && !details.dataset.initialized) {
    details.dataset.initialized = 'true';
    details.open = whitelist.length <= WHITELIST_OPEN_MAX;
  }

  if (whitelist.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px; color: #555;">No trusted sources added yet.</div>';
    return;
  }

  const platformLabels: Record<string, string> = {
    twitter: 'Twitter',
    reddit: 'Reddit',
    instagram: 'Instagram',
    youtube: 'YouTube',
    facebook: 'Facebook',
  };

  const platformColors: Record<string, string> = {
    twitter: '#1da1f2',
    reddit: '#ff4500',
    instagram: '#e1306c',
    youtube: '#ff0000',
    facebook: '#1877f2',
  };

  container.innerHTML = whitelist.map(entry => {
    const date = new Date(entry.createdAt).toLocaleDateString();
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #222;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="padding: 3px 8px; border-radius: 4px; font-size: 11px; background: ${platformColors[entry.platform]}22; color: ${platformColors[entry.platform]}; font-weight: 500;">${platformLabels[entry.platform]}</span>
          <span style="font-weight: 500; color: #fff;">${escapeHtml(entry.sourceId)}</span>
          ${entry.reason ? `<span style="color: #666; font-size: 12px;">"${escapeHtml(entry.reason)}"</span>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="color: #555; font-size: 11px;">Added ${date}</span>
          <button class="remove-whitelist-btn" data-source="${escapeHtml(entry.sourceId)}" data-platform="${entry.platform}" style="padding: 4px 8px; background: #4a2d2d; color: #ff9999; border: none; border-radius: 4px; font-size: 11px; cursor: pointer;">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

async function addWhitelistEntry(): Promise<void> {
  const sourceInput = document.getElementById('whitelist-source') as HTMLInputElement;
  const platformSelect = document.getElementById('whitelist-platform') as HTMLSelectElement;
  const reasonInput = document.getElementById('whitelist-reason') as HTMLInputElement;

  const sourceId = sourceInput?.value?.trim();
  const platform = platformSelect?.value as WhitelistEntry['platform'];
  const reason = reasonInput?.value?.trim();

  if (!sourceId) {
    alert('Please enter a username or source ID.');
    return;
  }

  // Get current settings
  const settings = await getSettings();
  const whitelist = settings.whitelist || [];

  // Check for duplicates
  const exists = whitelist.some(e =>
    e.sourceId.toLowerCase() === sourceId.toLowerCase() && e.platform === platform
  );

  if (exists) {
    alert('This source is already in your whitelist.');
    return;
  }

  // Add new entry
  const newEntry: WhitelistEntry = {
    sourceId,
    platform,
    createdAt: Date.now(),
    reason: reason || undefined,
  };

  settings.whitelist = [...whitelist, newEntry];

  // Save settings
  await chrome.storage.local.set({ settings });
  console.log('Added to whitelist:', newEntry);

  // Clear inputs
  if (sourceInput) sourceInput.value = '';
  if (reasonInput) reasonInput.value = '';

  // Re-render list
  renderWhitelist(settings.whitelist);
}

async function removeWhitelistEntry(sourceId: string, platform: WhitelistEntry['platform']): Promise<void> {
  const settings = await getSettings();
  const whitelist = settings.whitelist || [];

  // Remove the entry
  settings.whitelist = whitelist.filter(e =>
    !(e.sourceId.toLowerCase() === sourceId.toLowerCase() && e.platform === platform)
  );

  // Save settings
  await chrome.storage.local.set({ settings });
  console.log('Removed from whitelist:', sourceId, platform);

  // Re-render list
  renderWhitelist(settings.whitelist);
}

// "Right now" line under the strictness slider: the threshold actually applied this
// moment, which is the current phase's setting plus the daily-feedback adjustment
async function renderThresholdNow(): Promise<void> {
  const box = document.getElementById('threshold-now');
  const text = document.getElementById('threshold-now-text');
  const resetBtn = document.getElementById('threshold-adjust-reset') as HTMLButtonElement | null;
  if (!box || !text || !resetBtn) return;
  try {
    const session = await chrome.runtime.sendMessage({ type: 'GET_GLOBAL_SESSION' }) as { phase?: string } | null;
    const phase = session?.phase ?? 'normal';
    const [thresholdResult, adaptiveResult, settings] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_EFFECTIVE_BLUR_THRESHOLD', phase }) as Promise<{ threshold?: number } | null>,
      chrome.runtime.sendMessage({ type: 'GET_ADAPTIVE_SETTINGS' }) as Promise<{ adaptive?: { blurThresholdOffset?: number } } | null>,
      getSettings(),
    ]);
    const threshold = thresholdResult?.threshold;
    if (threshold === undefined) return;
    const offset = adaptiveResult?.adaptive?.blurThresholdOffset ?? 0;
    const phaseLabel = phase === 'wind-down' ? 'wind-down' : phase;

    let line = threshold >= 100
      ? `Right now (${phaseLabel} phase): nothing is blurred by score.`
      : `Right now (${phaseLabel} phase): blurring scores of ${threshold} and up.`;
    if (offset !== 0) {
      line += ` That's your setting ${offset < 0 ? 'lowered' : 'raised'} by ${Math.abs(offset)} from your daily "too easy / too restricted" answers.`;
    }
    if (settings.qualityMode) line += ` Quality mode is on, which blurs everything scoring above ${QUALITY_MODE_THRESHOLD - 1}.`;
    if (settings.subscriptionsOnly) line += ' Subscriptions-only is on, which blurs everything not trusted.';
    text.textContent = line;
    box.style.display = '';

    resetBtn.style.display = offset !== 0 ? '' : 'none';
    resetBtn.onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'RESET_THRESHOLD_ADJUSTMENT' });
      await renderThresholdNow();
    };
  } catch {
    // Background unavailable; leave the line hidden
  }
}
