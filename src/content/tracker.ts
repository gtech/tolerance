// Lightweight heartbeat tracker for non-Reddit social media sites
// Just sends periodic heartbeats to background - no DOM manipulation

import { log } from '../shared/constants';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

function sendHeartbeat(): void {
  try {
    chrome.runtime.sendMessage({ type: 'SOCIAL_MEDIA_HEARTBEAT' }, () => {
      // Ignore errors (extension might be updating/disabled)
      if (chrome.runtime.lastError) {
        // Silent fail
      }
    });
  } catch {
    // Extension context invalidated
  }
}

// Send heartbeat on load
sendHeartbeat();

// Send heartbeat every 30 seconds while page is active
const intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

// Also send on visibility change (tab becomes active)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sendHeartbeat();
  }
});

// Clean up on unload
window.addEventListener('beforeunload', () => {
  clearInterval(intervalId);
});

log.debug(' Social media tracker loaded');
