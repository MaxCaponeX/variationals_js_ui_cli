'use strict';
/**
 * Telegram notification sender
 */

const axios = require('axios');
const logger = require('./logger');
const settings = require('../core/settings');

class TgReport {
  constructor() {
    this.logs = '';
  }

  updateLogs(text) {
    this.logs += text + '\n';
  }

  async sendLog(logs) {
    const cfg = settings.get();
    const botToken = cfg.telegram.botToken;
    const userIds = cfg.telegram.userIds;

    const notificationText = logs || this.logs;
    if (!botToken || !notificationText) return;

    // Split into 1900-char chunks (Telegram limit is 4096 but we keep it safe)
    const chunks = [];
    let remaining = notificationText;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 1900));
      remaining = remaining.slice(1900);
    }

    for (const userId of userIds) {
      for (const chunk of chunks) {
        try {
          const resp = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              chat_id: userId,
              text: chunk,
            }
          );
          if (!resp.data.ok) throw new Error(JSON.stringify(resp.data));
        } catch (err) {
          logger.error(`TG | Send error to ${userId}: ${err.message}`);
        }
      }
    }
  }
}

module.exports = TgReport;
