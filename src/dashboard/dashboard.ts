import { SessionLog, AppState, Settings, DEFAULT_SETTINGS, NarrativeTheme, EmergingNarrative, CounterStrategy, DailyNarrativeStats, WhitelistEntry } from '../shared/types';

interface CalibrationEntry {
  postId: string;
  heuristicScore: number;
  apiScore: number;
  timestamp: number;
  permalink?: string;
  title?: string;
  subreddit?: string;
  apiReason?: string;
  apiFullResponse?: unknown;
  heuristicFactors?: string[];
}

interface ApiUsage {
  totalCalls: number;
  totalCost: number;
  lastReset: number;
}

interface DashboardData {
  sessions: SessionLog[];
  calibration: CalibrationEntry[];
  apiUsage: ApiUsage;
}

async function init(): Promise<void> {
  // Load state
  const state = await getState();
  updateModeDisplay(state);

  // Load settings
  const settings = await getSettings();
  populateSettings(settings);
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

  // Set up event listeners
  setupEventListeners();

  // Start blur overlay countdowns
  startBlurOverlayCountdowns();

  // Scroll to API setup section if hash is present
  if (window.location.hash === '#api-setup') {
    scrollToApiSetup();
  }

  // Refresh global session every 30 seconds
  setInterval(loadGlobalSession, 30000);
}

async function getState(): Promise<AppState> {
  const result = await chrome.storage.local.get('state');
  return result.state || {
    mode: 'baseline',
    baselineStartDate: Date.now(),
    baselineDurationDays: 7,
    currentSessionId: null,
  };
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings');
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

async function updateApiStatus(settings: Settings): Promise<void> {
  const isFreeTier = settings.apiTier !== 'own-key';
  const hasOpenRouterKey = Boolean(settings.openRouterApiKey?.trim());
  const hasCustomEndpoint = settings.apiProvider?.type === 'openai-compatible' &&
                            Boolean(settings.apiProvider?.endpoint?.trim());
  const isApiConfigured = isFreeTier || hasOpenRouterKey || hasCustomEndpoint;

  // Check for free tier exhaustion
  const errorStateResult = await chrome.storage.local.get('apiErrorState');
  const errorState = errorStateResult.apiErrorState as { exhausted: boolean; message: string } | undefined;
  const isExhausted = isFreeTier && errorState?.exhausted;

  // Update header status
  const statusDot = document.getElementById('api-status-dot');
  const statusText = document.getElementById('api-status-text');

  if (statusDot && statusText) {
    if (isExhausted) {
      statusDot.style.background = '#e74c3c';
      statusText.textContent = 'Free Tier Exhausted';
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
      apiKeyStatus.textContent = '⚠ Free tier daily limit reached. Add your own OpenRouter API key for unlimited usage.';
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
      apiKeyStatus.textContent = 'Enter your OpenRouter API key to enable post scoring.';
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

  // Platform toggles
  const platformReddit = document.getElementById('platform-reddit') as HTMLInputElement;
  const platformTwitter = document.getElementById('platform-twitter') as HTMLInputElement;
  const platformYoutube = document.getElementById('platform-youtube') as HTMLInputElement;
  const platformInstagram = document.getElementById('platform-instagram') as HTMLInputElement;

  if (platformReddit) platformReddit.checked = settings.platforms?.reddit ?? true;
  if (platformTwitter) platformTwitter.checked = settings.platforms?.twitter ?? true;
  if (platformYoutube) platformYoutube.checked = settings.platforms?.youtube ?? true;
  if (platformInstagram) platformInstagram.checked = settings.platforms?.instagram ?? true;

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

  if (apiKeyInput && settings.openRouterApiKey) {
    apiKeyInput.value = settings.openRouterApiKey;
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

  if (rescueTimeInput && settings.rescueTimeApiKey) {
    rescueTimeInput.value = settings.rescueTimeApiKey;
  }

  if (todoistInput && settings.todoistUrl) {
    todoistInput.value = settings.todoistUrl;
  }

  if (jobSearchInput && settings.jobSearchLink) {
    jobSearchInput.value = settings.jobSearchLink;
  }

  // Blur settings
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
  if (customApiKeyInput) {
    customApiKeyInput.value = provider.apiKey || '';
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
  const defaultBlurThresholds = { normal: 100, reduced: 55, windDown: 45, minimal: 30 };
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
  const blurNormal = document.getElementById('blur-normal') as HTMLInputElement;
  const blurReduced = document.getElementById('blur-reduced') as HTMLInputElement;
  const blurWinddown = document.getElementById('blur-winddown') as HTMLInputElement;
  const blurMinimal = document.getElementById('blur-minimal') as HTMLInputElement;

  if (blurNormal) {
    blurNormal.value = String(blurThresholds.normal);
    const valueEl = document.getElementById('blur-normal-value');
    if (valueEl) valueEl.textContent = String(blurThresholds.normal);
  }
  if (blurReduced) {
    blurReduced.value = String(blurThresholds.reduced);
    const valueEl = document.getElementById('blur-reduced-value');
    if (valueEl) valueEl.textContent = String(blurThresholds.reduced);
  }
  if (blurWinddown) {
    blurWinddown.value = String(blurThresholds.windDown);
    const valueEl = document.getElementById('blur-winddown-value');
    if (valueEl) valueEl.textContent = String(blurThresholds.windDown);
  }
  if (blurMinimal) {
    blurMinimal.value = String(blurThresholds.minimal);
    const valueEl = document.getElementById('blur-minimal-value');
    if (valueEl) valueEl.textContent = String(blurThresholds.minimal);
  }

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
}

async function loadDashboardData(): Promise<void> {
  try {
    // Get all data from background script via messaging
    const result = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }) as {
      sessions: SessionLog[];
      calibration: CalibrationEntry[];
      apiUsage: ApiUsage;
    } | null;

    if (!result) {
      console.error('Failed to get dashboard data');
      return;
    }

    const sessions = result.sessions || [];
    const apiUsage = result.apiUsage || { totalCalls: 0, totalCost: 0, lastReset: Date.now() };

    console.log('Dashboard data received:', {
      sessionsCount: sessions.length,
      apiUsage,
    });

    // Calculate totals
    let totalPosts = 0;
    let totalHigh = 0;
    let totalMedium = 0;
    let totalLow = 0;
    let postsReordered = 0;

    for (const session of sessions) {
      const posts = session.posts || [];
      const dist = session.engagementDistribution || { high: 0, medium: 0, low: 0 };
      totalPosts += posts.length;
      totalHigh += dist.high || 0;
      totalMedium += dist.medium || 0;
      totalLow += dist.low || 0;
      postsReordered += posts.filter(p => p.wasReordered).length;
    }

    // Update stats
    const totalPostsEl = document.getElementById('total-posts');
    const totalSessionsEl = document.getElementById('total-sessions');
    const postsReorderedEl = document.getElementById('posts-reordered');

    if (totalPostsEl) totalPostsEl.textContent = String(totalPosts);
    if (totalSessionsEl) totalSessionsEl.textContent = String(sessions.length);
    if (postsReorderedEl) postsReorderedEl.textContent = String(postsReordered);

    // Update API usage
    const apiCostEl = document.getElementById('api-cost');
    const apiCallsEl = document.getElementById('api-calls');

    if (apiCostEl) apiCostEl.textContent = `$${(apiUsage.totalCost || 0).toFixed(4)}`;
    if (apiCallsEl) apiCallsEl.textContent = String(apiUsage.totalCalls || 0);

    // Update distribution bars
    const total = totalHigh + totalMedium + totalLow;
    if (total > 0) {
      updateBar('high', totalHigh / total);
      updateBar('medium', totalMedium / total);
      updateBar('low', totalLow / total);
    }

    // Update sessions list
    updateSessionsList(sessions);

  } catch (error) {
    console.error('Failed to load dashboard data:', error);
  }
}

function updateBar(bucket: string, ratio: number): void {
  const bar = document.getElementById(`bar-${bucket}`);
  const pct = document.getElementById(`pct-${bucket}`);

  if (bar) {
    bar.style.width = `${ratio * 100}%`;
  }
  if (pct) {
    pct.textContent = `${Math.round(ratio * 100)}%`;
  }
}

function updateSessionsList(sessions: SessionLog[]): void {
  const list = document.getElementById('sessions-list');
  if (!list) return;

  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-state">No sessions recorded yet</div>';
    return;
  }

  // Show most recent first, limit to 20
  const recent = sessions.slice().reverse().slice(0, 20);

  list.innerHTML = recent.map(session => {
    const date = new Date(session.startTime);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    const duration = session.endTime
      ? Math.round((session.endTime - session.startTime) / 60000)
      : '--';

    return `
      <div class="session-item">
        <div>
          <div class="session-date">${dateStr}</div>
          <div style="font-size: 12px; color: #555;">${duration} min</div>
        </div>
        <div class="session-stats">
          ${session.posts.length} posts
          (${session.engagementDistribution.high}H / ${session.engagementDistribution.medium}M / ${session.engagementDistribution.low}L)
        </div>
      </div>
    `;
  }).join('');
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
  const platformReddit = document.getElementById('platform-reddit');
  const platformTwitter = document.getElementById('platform-twitter');
  const platformYoutube = document.getElementById('platform-youtube');
  const platformInstagram = document.getElementById('platform-instagram');

  if (platformReddit) platformReddit.addEventListener('change', saveSettings);
  if (platformTwitter) platformTwitter.addEventListener('change', saveSettings);
  if (platformYoutube) platformYoutube.addEventListener('change', saveSettings);
  if (platformInstagram) platformInstagram.addEventListener('change', saveSettings);

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

  if (customEndpointInput) customEndpointInput.addEventListener('change', saveSettings);
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
  const logLevelSelect = document.getElementById('log-level') as HTMLSelectElement;

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
    openRouterApiKey: apiKeyInput?.value || undefined,
    apiProvider: {
      type: providerType,
      endpoint: providerType === 'openai-compatible' ? (customEndpointInput?.value?.trim() || undefined) : undefined,
      apiKey: providerType === 'openai-compatible' ? (customApiKeyInput?.value?.trim() || undefined) : undefined,
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
    },
    scheduler: {
      ...existing.scheduler, // Preserve progressive boredom settings
      highEngagementRatio: parseFloat(ratioInput?.value || '0.2'),
      cooldownPosts: parseInt(cooldownInput?.value || '5', 10),
      enabled: true,
    },
    productivityCardEnabled: productivityCardEnabledInput?.checked ?? false,
    rescueTimeApiKey: rescueTimeInput?.value || undefined,
    todoistUrl: todoistInput?.value || undefined,
    jobSearchLink: jobSearchInput?.value || undefined,
    twitter: {
      ...existing.twitter, // Preserve existing twitter settings
      hoverRevealDelay: parseInt(hoverDelayInput?.value || '3', 10),
      blurIntensity: parseInt(blurIntensityInput?.value || '8', 10),
    },
    logLevel: (logLevelSelect?.value as Settings['logLevel']) || 'error',
  };

  await chrome.storage.local.set({ settings });
  console.log('Settings saved, apiSampleRate:', apiSampleRate, 'hoverDelay:', settings.twitter?.hoverRevealDelay);

  // Update API status display
  await updateApiStatus(settings);
}

async function exportData(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }) as DashboardData | null;

    if (!result) {
      alert('Failed to get data for export.');
      return;
    }

    const data = {
      exportDate: new Date().toISOString(),
      sessions: result.sessions,
      calibration: result.calibration,
      apiUsage: result.apiUsage,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `tolerance-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
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

  // For now, just clear local storage - full DB clear would need background message
  // This is a simplified version; full implementation would add CLEAR_DATA message handler
  try {
    await chrome.storage.local.clear();
    await loadDashboardData();
    alert('Data cleared successfully. Reload the extension to reinitialize.');
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

    // Load trends
    await loadNarrativeTrends(currentTrendDays);

    // Load emerging narratives
    await loadEmergingNarratives();

    // Load counter-strategies
    await loadCounterStrategies();

    // Set up narrative event listeners
    setupNarrativeEventListeners();
  } catch (error) {
    console.error('Failed to load narrative data:', error);
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
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No narrative data yet. Browse Reddit to start tracking.</div>';
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
      alertEl.innerHTML = `<strong>Alert:</strong> ${spikes.join(', ')}`;
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
        <span class="narrative-label" title="${theme.name}">${theme.name}</span>
        <div class="narrative-bar-container">
          <div class="narrative-bar ${colorClass}" style="width: ${Math.min(100, exposure)}%"></div>
          ${baseline > 0 ? `<div class="baseline-marker" style="left: ${Math.min(100, baseline)}%"></div>` : ''}
        </div>
        <span class="narrative-value">${exposure}%</span>
      </div>
    `);
  }

  if (bars.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No active narrative themes.</div>';
  } else {
    container.innerHTML = bars.join('');
  }
}

async function loadEmergingNarratives(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_EMERGING_NARRATIVES' }) as {
      emerging: EmergingNarrative[];
      unclassifiedCount: number;
    } | null;

    const emerging = result?.emerging?.filter(e => e.status === 'pending') || [];
    const unclassifiedCount = result?.unclassifiedCount || 0;

    // Update unclassified count
    const countEl = document.getElementById('unclassified-count');
    if (countEl) countEl.textContent = String(unclassifiedCount);

    // Update badge
    const badgeEl = document.getElementById('emerging-badge');
    if (badgeEl) {
      if (emerging.length > 0) {
        badgeEl.style.display = 'inline-block';
        badgeEl.textContent = String(emerging.length);
      } else {
        badgeEl.style.display = 'none';
      }
    }

    renderEmergingNarratives(emerging);
  } catch (error) {
    console.error('Failed to load emerging narratives:', error);
  }
}

function renderEmergingNarratives(emerging: EmergingNarrative[]): void {
  const container = document.getElementById('emerging-list');
  if (!container) return;

  if (emerging.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No emerging patterns detected yet.</div>';
    return;
  }

  container.innerHTML = emerging.map(narrative => `
    <div class="emerging-item" data-id="${narrative.id}">
      <div class="emerging-name">${escapeHtml(narrative.suggestedName)}</div>
      <div class="emerging-desc">${escapeHtml(narrative.description)}</div>
      <div class="emerging-samples">
        ${narrative.sampleTitles.slice(0, 3).map(t => `<div class="emerging-sample">"${escapeHtml(t.slice(0, 80))}..."</div>`).join('')}
      </div>
      <div class="emerging-actions">
        <button class="btn-primary confirm-emerging-btn" data-id="${narrative.id}">Confirm</button>
        <button class="btn-secondary dismiss-emerging-btn" data-id="${narrative.id}">Dismiss</button>
      </div>
    </div>
  `).join('');
}

async function loadCounterStrategies(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_COUNTER_STRATEGIES' }) as {
      strategies: CounterStrategy[];
    } | null;

    renderCounterStrategies(result?.strategies || []);
  } catch (error) {
    console.error('Failed to load counter-strategies:', error);
  }
}

function renderCounterStrategies(strategies: CounterStrategy[]): void {
  const container = document.getElementById('strategies-list');
  if (!container) return;

  if (strategies.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px;">No counter-strategies configured. Add one to start.</div>';
    return;
  }

  container.innerHTML = strategies.map(strategy => {
    const theme = currentNarrativeThemes.find(t => t.id === strategy.themeId);
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
          <div class="dialectic-col">
            <div class="dialectic-label">Antithesis</div>
            <div class="dialectic-text">${escapeHtml(strategy.antithesis.slice(0, 100))}${strategy.antithesis.length > 100 ? '...' : ''}</div>
          </div>
          <div class="dialectic-col">
            <div class="dialectic-label">Synthesis</div>
            <div class="dialectic-text">${escapeHtml(strategy.synthesis.slice(0, 100))}${strategy.synthesis.length > 100 ? '...' : ''}</div>
          </div>
        </div>
        <div class="strategy-meta">
          Suppression: ${strategy.suppressThreshold}% | Keywords: ${strategy.surfaceKeywords.join(', ') || 'None'}
        </div>
      </div>
    `;
  }).join('');
}

function setupNarrativeEventListeners(): void {
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

  // Trigger discovery button
  const discoveryBtn = document.getElementById('trigger-discovery-btn');
  if (discoveryBtn) {
    discoveryBtn.addEventListener('click', async () => {
      discoveryBtn.textContent = 'Running discovery...';
      (discoveryBtn as HTMLButtonElement).disabled = true;

      try {
        await chrome.runtime.sendMessage({ type: 'TRIGGER_NARRATIVE_DISCOVERY' });
        await loadEmergingNarratives();
      } catch (error) {
        console.error('Discovery failed:', error);
      }

      const countEl = document.getElementById('unclassified-count');
      discoveryBtn.innerHTML = `Run Discovery (<span id="unclassified-count">${countEl?.textContent || '0'}</span> unclassified posts)`;
      (discoveryBtn as HTMLButtonElement).disabled = false;
    });
  }

  // Confirm/dismiss emerging narrative buttons (delegated)
  document.getElementById('emerging-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    if (target.classList.contains('confirm-emerging-btn')) {
      const id = target.dataset.id;
      if (id) {
        await chrome.runtime.sendMessage({ type: 'CONFIRM_EMERGING_NARRATIVE', id });
        await loadEmergingNarratives();
        await loadNarrativeData(); // Refresh themes
      }
    }

    if (target.classList.contains('dismiss-emerging-btn')) {
      const id = target.dataset.id;
      if (id) {
        await chrome.runtime.sendMessage({ type: 'DISMISS_EMERGING_NARRATIVE', id });
        await loadEmergingNarratives();
      }
    }
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
      if (id && confirm('Delete this counter-strategy?')) {
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

  // Suppression slider value display
  const suppressSlider = document.getElementById('strategy-suppress') as HTMLInputElement;
  const suppressValue = document.getElementById('suppress-value');
  if (suppressSlider && suppressValue) {
    suppressSlider.addEventListener('input', () => {
      suppressValue.textContent = suppressSlider.value;
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

  // Reset form
  const thesisEl = document.getElementById('strategy-thesis') as HTMLTextAreaElement;
  const antithesisEl = document.getElementById('strategy-antithesis') as HTMLTextAreaElement;
  const synthesisEl = document.getElementById('strategy-synthesis') as HTMLTextAreaElement;
  const suppressEl = document.getElementById('strategy-suppress') as HTMLInputElement;
  const keywordsEl = document.getElementById('strategy-keywords') as HTMLInputElement;
  const notesEl = document.getElementById('strategy-notes') as HTMLTextAreaElement;
  const suppressValueEl = document.getElementById('suppress-value');

  if (strategyId) {
    // Edit existing strategy
    const result = await chrome.runtime.sendMessage({ type: 'GET_COUNTER_STRATEGIES' }) as {
      strategies: CounterStrategy[];
    } | null;
    const strategy = result?.strategies?.find(s => s.id === strategyId);

    if (strategy) {
      if (themeSelect) themeSelect.value = strategy.themeId;
      if (thesisEl) thesisEl.value = strategy.thesis;
      if (antithesisEl) antithesisEl.value = strategy.antithesis;
      if (synthesisEl) synthesisEl.value = strategy.synthesis;
      if (suppressEl) suppressEl.value = String(strategy.suppressThreshold);
      if (suppressValueEl) suppressValueEl.textContent = String(strategy.suppressThreshold);
      if (keywordsEl) keywordsEl.value = strategy.surfaceKeywords.join(', ');
      if (notesEl) notesEl.value = strategy.notes || '';
    }
  } else {
    // New strategy - auto-fill thesis from first theme
    const firstTheme = currentNarrativeThemes.find(t => t.active);
    if (thesisEl && firstTheme) thesisEl.value = firstTheme.description;
    if (antithesisEl) antithesisEl.value = '';
    if (synthesisEl) synthesisEl.value = '';
    if (suppressEl) suppressEl.value = '50';
    if (suppressValueEl) suppressValueEl.textContent = '50';
    if (keywordsEl) keywordsEl.value = '';
    if (notesEl) notesEl.value = '';
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
  const suppressEl = document.getElementById('strategy-suppress') as HTMLInputElement;
  const keywordsEl = document.getElementById('strategy-keywords') as HTMLInputElement;
  const notesEl = document.getElementById('strategy-notes') as HTMLTextAreaElement;

  const strategy: CounterStrategy = {
    id: editingStrategyId || `strategy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    themeId: themeSelect?.value || '',
    thesis: thesisEl?.value || '',
    antithesis: antithesisEl?.value || '',
    synthesis: synthesisEl?.value || '',
    suppressThreshold: parseInt(suppressEl?.value || '50', 10),
    surfaceKeywords: (keywordsEl?.value || '').split(',').map(k => k.trim()).filter(k => k),
    enabled: true,
    createdAt: Date.now(),
    notes: notesEl?.value || '',
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy });
  closeStrategyModal();
  await loadCounterStrategies();
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

  // Update button state
  btn.disabled = true;
  btn.textContent = 'Testing...';
  statusEl.style.display = 'block';
  statusEl.style.background = '#2d3a4a';
  statusEl.style.color = '#99bbff';
  statusEl.textContent = 'Connecting to endpoint...';

  try {
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
      const currentRatio = ratios[phase as keyof typeof ratios] ?? 0.2;
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
// Blur Overlay Countdowns (Meta-friction)
// ==========================================

function startBlurOverlayCountdowns(): void {
  // Platform controls countdown (30 seconds)
  startCountdown('platform-blur-overlay', 'platform-countdown', 30);

  // Threshold controls countdown (30 seconds)
  startCountdown('threshold-blur-overlay', 'threshold-countdown', 30);

  // Set up threshold sliders and reset button
  setupThresholdControls();
}

function startCountdown(overlayId: string, countdownId: string, seconds: number): void {
  const overlay = document.getElementById(overlayId);
  const countdownEl = document.getElementById(countdownId);
  if (!overlay || !countdownEl) return;

  let remaining = seconds;
  countdownEl.textContent = String(remaining);

  const interval = setInterval(() => {
    remaining--;
    countdownEl.textContent = String(remaining);

    if (remaining <= 0) {
      clearInterval(interval);
      overlay.style.display = 'none';
    }
  }, 1000);
}

function setupThresholdControls(): void {
  // Blur threshold sliders - live update display
  const blurSliders = ['blur-normal', 'blur-reduced', 'blur-winddown', 'blur-minimal'];
  for (const id of blurSliders) {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueEl = document.getElementById(`${id}-value`);
    if (slider && valueEl) {
      slider.addEventListener('input', () => {
        valueEl.textContent = slider.value;
      });
      slider.addEventListener('change', saveCustomThresholds);
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
      });
      slider.addEventListener('change', saveCustomThresholds);
    }
  }

  // Reset button (in threshold controls section)
  const resetBtn = document.getElementById('reset-thresholds-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetThresholdsToCalibrated);
  }

  // Quick reset button (always visible, above API key)
  const quickResetBtn = document.getElementById('quick-reset-btn');
  if (quickResetBtn) {
    quickResetBtn.addEventListener('click', resetThresholdsToCalibrated);
  }
}

async function saveCustomThresholds(): Promise<void> {
  const existing = await getSettings();

  // Read all slider values
  const blurNormal = parseInt((document.getElementById('blur-normal') as HTMLInputElement)?.value || '100', 10);
  const blurReduced = parseInt((document.getElementById('blur-reduced') as HTMLInputElement)?.value || '55', 10);
  const blurWinddown = parseInt((document.getElementById('blur-winddown') as HTMLInputElement)?.value || '45', 10);
  const blurMinimal = parseInt((document.getElementById('blur-minimal') as HTMLInputElement)?.value || '30', 10);

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
  const defaultBlurThresholds = { normal: 100, reduced: 55, windDown: 45, minimal: 30 };
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

function renderWhitelist(whitelist: WhitelistEntry[]): void {
  const container = document.getElementById('whitelist-list');
  if (!container) return;

  if (whitelist.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px; color: #555;">No trusted sources added yet.</div>';
    return;
  }

  const platformLabels: Record<string, string> = {
    twitter: 'Twitter/X',
    reddit: 'Reddit',
    instagram: 'Instagram',
    youtube: 'YouTube',
  };

  const platformColors: Record<string, string> = {
    twitter: '#1da1f2',
    reddit: '#ff4500',
    instagram: '#e1306c',
    youtube: '#ff0000',
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
