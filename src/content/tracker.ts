// Lightweight heartbeat tracker for non-Reddit social media sites
// Just sends periodic heartbeats to background - no DOM manipulation

import { log } from '../shared/constants';
import { heartbeatMessage, handleHeartbeatResponse } from './grounding';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

function sendHeartbeat(): void {
  // Don't count time when tab is not visible
  if (document.visibilityState !== 'visible') {
    return;
  }

  try {
    chrome.runtime.sendMessage(heartbeatMessage(), (response) => {
      if (chrome.runtime.lastError) return; // Extension might be updating
      handleHeartbeatResponse(response);
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
