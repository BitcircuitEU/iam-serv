import { chromium } from 'playwright';
import winston from 'winston';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.DEBUG === 'true' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bmw-downloader.log' })
  ]
});

class BMWISTADownloader {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.downloadDir = process.env.DOWNLOAD_DIR || './downloads';
    this.isLoggedIn = false;
    this.metadata = {};
    
    // Define download categories for both ISTA-P and ISTA-Next
    this.downloadCategories = {
      'ista-p': {
        'installer': 'Installationsprogramm ISTA/P',
        'data_archive': 'Datenarchiv ISTA/P'
      },
      'ista-next': {
        'client': 'Installationsdatei ISTA Client',
        'programming_data': 'ISTA Programmierdaten',
        'icom_firmware': 'ICOM Next Firmware',
        'ptd_driver': 'BMW PTD-Treiber'
      }
    };
  }

  async initialize() {
    logger.info('🚀 BMW ISTA-P Downloader wird initialisiert...');
    
    // Create download directory
    await fs.mkdir(this.downloadDir, { recursive: true });
    
    // Load metadata
    await this.loadMetadata();
    
    // Launch browser
    await this.launchBrowser();
  }

  async launchBrowser() {
    logger.info('🌐 Starte Browser...');
    
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS === 'true',
      args: ['--disable-blink-features=AutomationControlled']
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'de-DE',
      acceptDownloads: true,
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    this.page = await this.context.newPage();
    
    // Log console messages for debugging
    if (process.env.DEBUG === 'true') {
      this.page.on('console', msg => {
        if (msg.type() === 'error') {
          logger.debug(`Browser Console Error: ${msg.text()}`);
        }
      });
    }
  }

  async login() {
    if (this.isLoggedIn) {
      logger.info('✅ Bereits eingeloggt');
      return true;
    }

    logger.info('🔐 Logge bei BMW ein...');
    
    try {
      // Navigate to auth page
      await this.page.goto(process.env.BMW_AUTH_URL, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      // Wait for login form
      await this.page.waitForSelector('input[name="j_username"], input[type="text"]', { timeout: 10000 });
      
      // Fill credentials
      await this.page.fill('input[name="j_username"], input[type="text"]', process.env.BMW_USERNAME);
      await this.page.fill('input[name="j_password"], input[type="password"]', process.env.BMW_PASSWORD);
      
      // Click login button
      await this.page.click('button[type="submit"], input[type="submit"]');
      
      // Wait for redirect
      try {
        await this.page.waitForURL('**/startpage-workshop**', { timeout: 30000 });
      } catch (error) {
        // Fallback: wait for any aos.bmwgroup.com page
        await this.page.waitForURL('https://aos.bmwgroup.com/**', { timeout: 30000 });
      }
      
      // Additional wait for page to fully load
      await this.page.waitForLoadState('networkidle');
      
      // Check if we're on the startpage-workshop (successful login)
      const currentUrl = this.page.url();
      if (currentUrl.includes('startpage-workshop') || currentUrl.includes('aos.bmwgroup.com')) {
        this.isLoggedIn = true;
        logger.info('✅ Login erfolgreich!');
        return true;
      } else {
        throw new Error(`Login verification failed - URL: ${currentUrl}`);
      }
      
    } catch (error) {
      logger.error(`❌ Login fehlgeschlagen: ${error.message}`);
      return false;
    }
  }

  async navigateToApplication(appType) {
    const appName = appType === 'ista-p' ? 'ISTA-P' : 'ISTA-Next';
    const appUrl = appType === 'ista-p' ? process.env.BMW_ISTA_P_URL : process.env.BMW_ISTA_NEXT_URL;
    
    logger.info(`🧭 Navigiere zu ${appName}...`);
    
    try {
      // Navigate directly to the application
      await this.page.goto(appUrl, {
        waitUntil: 'networkidle',
        timeout: 60000
      });
      
      // Wait for the page to load
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(3000);
      
      const currentUrl = this.page.url();
      logger.info(`✅ Erfolgreich zu ${appName} navigiert: ${currentUrl}`);
      
      return true;
    } catch (error) {
      logger.error(`❌ Navigation zu ${appName} fehlgeschlagen: ${error.message}`);
      return false;
    }
  }

  async findDownloads(appType) {
    const appName = appType === 'ista-p' ? 'ISTA-P' : 'ISTA-Next';
    logger.info(`🔍 Suche nach Downloads auf der ${appName} Seite...`);
    
    try {
      // Wait for the page to be fully loaded
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(2000);
      
      // Wait for frames to load
      logger.debug('Warte auf Frames...');
      try {
        await this.page.waitForFunction(() => {
          const frames = document.querySelectorAll('iframe');
          return frames.length > 0;
        }, { timeout: 10000 });
        logger.debug('Frames gefunden');
      } catch (e) {
        logger.debug('Keine Frames gefunden, suche nur in Hauptseite');
      }
      
      // Execute JavaScript to find all download links (including frames)
      const downloads = await this.page.evaluate(() => {
        const foundDownloads = [];
        const frameInfo = {
          totalFrames: 0,
          accessibleFrames: 0,
          totalLinks: 0,
          downloadLinks: 0
        };
        
        // Function to search for downloads in a document
        function searchForDownloads(doc, frameInfo = 'main') {
          // Find all links that might be downloads
          const links = doc.querySelectorAll('a[href]');
          
          links.forEach(link => {
            const href = link.href;
            const text = link.textContent.trim();
            
            // Skip PDF files completely
            if (href.toLowerCase().includes('.pdf') || text.toLowerCase().includes('.pdf')) {
              return;
            }
            
            // Check if this looks like a download link
            if (href && href.includes('/api/v2/downloads') && text) {
              foundDownloads.push({
                title: text,
                url: href,
                method: `link_search_${frameInfo}`
              });
            }
          });
          
          // Also look for buttons that might trigger downloads
          const buttons = doc.querySelectorAll('button, [role="button"]');
          buttons.forEach(button => {
            const text = button.textContent.trim();
            const onclick = button.getAttribute('onclick');
            
            if (text && onclick && onclick.includes('download')) {
              foundDownloads.push({
                title: text,
                url: onclick,
                method: `button_search_${frameInfo}`
              });
            }
          });
        }
        
        // Search in main document
        searchForDownloads(document, 'main');
        
        // Search in all frames
        const frames = document.querySelectorAll('iframe');
        frameInfo.totalFrames = frames.length;
        
        frames.forEach((frame, index) => {
          try {
            const frameDoc = frame.contentDocument || frame.contentWindow?.document;
            if (frameDoc) {
              frameInfo.accessibleFrames++;
              searchForDownloads(frameDoc, `frame_${index}`);
            }
          } catch (e) {
            // Frame might be cross-origin and inaccessible
            // Skip this frame
          }
        });
        
        return { downloads: foundDownloads, frameInfo };
      });
      
      // Log frame information
      logger.debug(`Frame-Analyse: ${downloads.frameInfo.totalFrames} Frames gefunden, ${downloads.frameInfo.accessibleFrames} zugänglich`);
      
      const foundDownloads = downloads.downloads;
      
      logger.debug(`Gefundene Downloads (roh): ${foundDownloads.length}`);
      foundDownloads.forEach((download, index) => {
        logger.debug(`  ${index + 1}. ${download.title}: ${download.url} [${download.method}]`);
      });
      
      // Additional debug: Check for programming data specifically
      const programmingDataLinks = foundDownloads.filter(d => 
        d.url.toLowerCase().includes('programmingdata') || 
        d.url.toLowerCase().includes('istauss_programmingdata_') ||
        d.title.toLowerCase().includes('programmierdaten')
      );
      if (programmingDataLinks.length > 0) {
        logger.debug(`🔍 Potentielle Programmierdaten-Links gefunden: ${programmingDataLinks.length}`);
        programmingDataLinks.forEach((link, index) => {
          logger.debug(`  PD${index + 1}. ${link.title}: ${link.url}`);
        });
      } else {
        logger.debug(`❌ Keine Programmierdaten-Links gefunden`);
      }
      
      // Categorize downloads
      const categorizedDownloads = this.categorizeDownloads(foundDownloads, appType);
      
      logger.info(`✅ ${Object.keys(categorizedDownloads).length} Downloads kategorisiert`);
      
      return categorizedDownloads;
      
    } catch (error) {
      logger.error(`❌ Fehler beim Suchen der Downloads: ${error.message}`);
      return {};
    }
  }

  categorizeDownloads(downloads, appType) {
    const categorized = {};
    const validCategories = Object.keys(this.downloadCategories[appType] || {});
    
    logger.debug(`Kategorisiere Downloads für ${appType}...`);
    
          for (const download of downloads) {
        const title = download.title.toLowerCase();
        const url = download.url.toLowerCase();
        let category = null;
        
        logger.debug(`Prüfe Download: "${download.title}" -> ${download.url}`);
      
      if (appType === 'ista-p') {
        // ISTA-P categorization
        if (title.includes('installationsprogramm') || 
            title.includes('installationsdatei') || 
            url.includes('istaoss') || 
            url.includes('bdrclient')) {
          category = 'installer';
        }
        else if (title.includes('datenarchiv') || 
                 url.includes('commondat') || 
                 url.includes('.istapdata') ||
                 (url.includes('ista-p') && url.includes('commondat'))) {
          category = 'data_archive';
        }
      } else if (appType === 'ista-next') {
        // ISTA-Next categorization - Order matters!
        if (title.includes('programmierdaten') || 
            url.includes('ISTAOSS_ProgrammingData_')) {
          category = 'programming_data';
        }
        else if (title.includes('installationsdatei') || 
                 title.includes('client') || 
                 url.includes('istaoss') || 
                 url.includes('client')) {
          category = 'client';
        }
        else if ((title.includes('icom') && title.includes('firmware')) || 
                 url.includes('ICOM-Next-FW') ||
                 (url.includes('icom') && url.includes('fw'))) {
          category = 'icom_firmware';
        }
        else if (title.includes('ptd') || 
                 title.includes('treiber') || 
                 url.includes('ptd') ||
                 url.includes('passthru')) {
          category = 'ptd_driver';
        }
      }
      
      if (category && validCategories.includes(category) && !categorized[category]) {
        categorized[category] = {
          ...download,
          category,
          appType,
          displayName: this.downloadCategories[appType][category],
          version: this.extractVersion(download.url)
        };
        
        logger.debug(`✅ Kategorisiert: ${download.title} -> ${category}`);
      } else if (!category) {
        logger.debug(`❌ Unkategorisiert: ${download.title} (${download.url})`);
      } else if (!validCategories.includes(category)) {
        logger.debug(`❌ Ungültige Kategorie: ${category} für ${download.title}`);
      } else if (categorized[category]) {
        logger.debug(`❌ Kategorie bereits besetzt: ${category} für ${download.title}`);
      }
    }
    
    return categorized;
  }

  extractVersion(url) {
    const patterns = [
      /(\d+\.\d+\.\d+\.\d+)/,  // 3.74.0.930
      /(\d+\.\d+\.\d+)/,        // 4.53.30
      /(\d+-\d+-\d+)/,          // 04-25-10
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return 'unknown';
  }

  extractCleanFilename(url) {
    try {
      // Check if this is a BMW redirect URL or direct AWS URL
      let finalUrl = url;
      
      // If it's a BMW URL, we need to follow the redirect to get the actual filename
      if (url.includes('aos.bmwgroup.com/api/v2/downloads')) {
        // Extract the key parameter which contains the actual filename
        const keyMatch = url.match(/[?&]key=([^&]+)/);
        if (keyMatch) {
          const key = decodeURIComponent(keyMatch[1]);
          // Extract filename from the key (last part after /)
          const keyParts = key.split('/');
          let filename = keyParts[keyParts.length - 1];
          
          logger.debug(`   BMW URL detected, extracted key: ${key}`);
          logger.debug(`   Filename from key: ${filename}`);
          
          // Remove any query parameters from the filename
          if (filename.includes('?')) {
            filename = filename.split('?')[0];
          }
          
          // Remove URL encoding
          filename = decodeURIComponent(filename);
          
          // Additional cleanup: remove any remaining query parameters or unwanted suffixes
          if (filename.includes('&signed=true')) {
            filename = filename.replace('&signed=true', '');
            logger.debug(`   After removing &signed=true: ${filename}`);
          }
          
          // Validate filename
          if (filename && filename.length > 0 && filename !== 'download') {
            logger.debug(`   Final clean filename from BMW key: ${filename}`);
            return filename;
          }
        }
      } else if (url.includes('amazonaws.com')) {
        // Direct AWS URL - extract filename from path
        const urlParts = url.split('/');
        let filename = urlParts[urlParts.length - 1];
        
        logger.debug(`   AWS URL detected, original filename: ${filename}`);
        
        // Remove query parameters (everything after ?)
        if (filename.includes('?')) {
          filename = filename.split('?')[0];
          logger.debug(`   After removing query params: ${filename}`);
        }
        
        // Remove URL encoding
        filename = decodeURIComponent(filename);
        logger.debug(`   After URL decoding: ${filename}`);
        
        // Validate filename
        if (filename && filename.length > 0 && filename !== 'download') {
          logger.debug(`   Final clean filename from AWS: ${filename}`);
          return filename;
        }
      } else {
        // Fallback for other URLs
        const urlParts = url.split('/');
        let filename = urlParts[urlParts.length - 1];
        
        logger.debug(`   Other URL type, original filename: ${filename}`);
        
        // Remove query parameters (everything after ?)
        if (filename.includes('?')) {
          filename = filename.split('?')[0];
          logger.debug(`   After removing query params: ${filename}`);
        }
        
        // Remove URL encoding
        filename = decodeURIComponent(filename);
        logger.debug(`   After URL decoding: ${filename}`);
        
        // Additional cleanup: remove any remaining query parameters or unwanted suffixes
        if (filename.includes('&signed=true')) {
          filename = filename.replace('&signed=true', '');
          logger.debug(`   After removing &signed=true: ${filename}`);
        }
        
        // Validate filename
        if (filename && filename.length > 0 && filename !== 'download') {
          logger.debug(`   Final clean filename: ${filename}`);
          return filename;
        }
      }
      
      logger.debug(`   Invalid filename, returning null`);
      return null;
    } catch (error) {
      logger.debug(`Fehler beim Extrahieren des Dateinamens: ${error.message}`);
      return null;
    }
  }

    async downloadFile(download) {
    logger.info(`⬇️ Lade herunter: ${download.displayName}`);
    logger.debug(`   URL: ${download.url}`);
    
    try {
      // Extract clean filename first
      let fileName = this.extractCleanFilename(download.url);
      logger.debug(`   Extracted filename: ${fileName}`);
      
      if (!fileName || fileName === 'download' || fileName.length < 5) {
        const version = download.version !== 'unknown' ? `_${download.version}` : '';
        const extension = this.getFileExtension(download.url);
        fileName = `${download.category}${version}${extension}`;
        logger.debug(`   Generated fallback filename: ${fileName}`);
      }
      
      // Set up file path
      const filePath = path.join(this.downloadDir, fileName);
      
      // Use axios for direct download (more reliable)
      logger.debug(`   Starte Download mit axios...`);
      try {
        const axios = (await import('axios')).default;
        
        // Get cookies from the browser context
        const cookies = await this.context.cookies();
        const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        
        logger.debug(`   Cookies extrahiert: ${cookies.length} Cookies`);
        
        // Download with axios
        const response = await axios({
          method: 'GET',
          url: download.url,
          responseType: 'stream',
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/octet-stream,application/zip,application/x-msdownload,*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          },
          timeout: 300000 // 5 minutes
        });
        
        logger.debug(`   HTTP Response erhalten: ${response.status} ${response.statusText}`);
        
        // Create write stream
        const writer = createWriteStream(filePath);
        response.data.pipe(writer);
        
        // Wait for download to complete
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        logger.debug(`   Download-Stream abgeschlossen`);
        
        // Verify file
        const stats = await fs.stat(filePath);
        if (stats.size > 0) {
          logger.info(`✅ Download abgeschlossen: ${fileName} (${this.formatFileSize(stats.size)})`);
          
          // Update metadata
          const metadataKey = `${download.appType}_${download.category}`;
          await this.updateMetadata(metadataKey, {
            ...download,
            fileName,
            filePath,
            fileSize: stats.size,
            downloadedAt: new Date().toISOString()
          });
          
          return true;
        } else {
          throw new Error('Downloaded file is empty');
        }
        
      } catch (error) {
        logger.error(`❌ Download fehlgeschlagen: ${error.message}`);
        
        // Try to delete partial file
        try {
          await fs.unlink(filePath);
        } catch (e) {
          // Ignore deletion errors
        }
        
        return false;
      }
      
    } catch (error) {
      logger.error(`❌ Download fehlgeschlagen: ${error.message}`);
      return false;
    }
  }

  getFileExtension(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('.exe')) return '.exe';
    if (urlLower.includes('.zip')) return '.zip';
    if (urlLower.includes('.istapdata')) return '.istapdata';
    return '.bin'; // Default extension
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  isNewVersion(appType, category, version) {
    const metadataKey = `${appType}_${category}`;
    const lastVersion = this.metadata[metadataKey]?.version;
    
    if (!lastVersion) {
      return true; // No previous version, download it
    }

    if (version === 'unknown') {
      return false; // Can't compare unknown versions
    }

    return version !== lastVersion;
  }

  async checkForUpdates() {
    logger.info('🔍 Prüfe auf Updates...');
    
    if (!this.isLoggedIn) {
      const loginSuccess = await this.login();
      if (!loginSuccess) {
        logger.error('❌ Login fehlgeschlagen, überspringe Update-Check');
        return;
      }
    }

    let totalSuccessCount = 0;
    let totalFailCount = 0;

    // Check ISTA-P
    logger.info('📥 Prüfe ISTA-P Downloads...');
    const istaPSuccess = await this.checkApplicationUpdates('ista-p');
    totalSuccessCount += istaPSuccess.successCount;
    totalFailCount += istaPSuccess.failCount;

    // Add delay between applications
    logger.info('⏳ Warte 5 Sekunden vor ISTA-Next...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check ISTA-Next
    logger.info('📥 Prüfe ISTA-Next Downloads...');
    const istaNextSuccess = await this.checkApplicationUpdates('ista-next');
    totalSuccessCount += istaNextSuccess.successCount;
    totalFailCount += istaNextSuccess.failCount;

    logger.info(`📊 Gesamt-Download-Statistik: ${totalSuccessCount} erfolgreich, ${totalFailCount} fehlgeschlagen`);
  }

  async checkApplicationUpdates(appType) {
    const appName = appType === 'ista-p' ? 'ISTA-P' : 'ISTA-Next';
    logger.info(`🔍 Prüfe ${appName} auf Updates...`);
    
    // Navigate to application
    const navigationSuccess = await this.navigateToApplication(appType);
    if (!navigationSuccess) {
      logger.error(`❌ Navigation zu ${appName} fehlgeschlagen, überspringe Update-Check`);
      return { successCount: 0, failCount: 0 };
    }

    // Find downloads
    const downloads = await this.findDownloads(appType);
    
    // Check which downloads are new
    const updates = [];
    for (const [category, download] of Object.entries(downloads)) {
      if (this.isNewVersion(appType, category, download.version)) {
        updates.push(download);
        logger.info(`🆕 Neue Version gefunden: ${download.displayName} (${download.version})`);
      } else {
        logger.info(`✅ Aktuelle Version bereits vorhanden: ${download.displayName} (${download.version})`);
      }
    }

    // Initialize counters
    let successCount = 0;
    let failCount = 0;

    // Download updates
    if (updates.length > 0) {
      logger.info(`📥 ${updates.length} Updates für ${appName} werden heruntergeladen...`);
      
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        logger.info(`📥 Download ${i + 1}/${updates.length}: ${update.displayName}`);
        
        try {
          const success = await this.downloadFile(update);
          if (success) {
            successCount++;
          } else {
            failCount++;
          }
          
          // Add delay between downloads
          if (i < updates.length - 1) {
            logger.info('⏳ Warte 3 Sekunden vor dem nächsten Download...');
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
        } catch (error) {
          logger.error(`❌ Fehler beim Download von ${update.displayName}: ${error.message}`);
          failCount++;
        }
      }
      
      logger.info(`📊 ${appName} Download-Statistik: ${successCount} erfolgreich, ${failCount} fehlgeschlagen`);
      
    } else {
      logger.info(`✅ Keine Updates für ${appName} verfügbar`);
    }

    return { successCount, failCount };
  }

  async loadMetadata() {
    try {
      const metadataPath = path.join(this.downloadDir, 'metadata.json');
      const data = await fs.readFile(metadataPath, 'utf-8');
      this.metadata = JSON.parse(data);
      logger.debug('Metadata geladen');
    } catch (error) {
      logger.debug('Keine Metadata gefunden, starte mit leerem State');
      this.metadata = {};
    }
  }

  async updateMetadata(category, data) {
    this.metadata[category] = data;
    const metadataPath = path.join(this.downloadDir, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(this.metadata, null, 2));
    logger.debug(`Metadata aktualisiert für ${category}`);
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      logger.info('🔒 Browser geschlossen');
    }
  }

  async run() {
    try {
      await this.initialize();
      
      // Get check interval from environment (default: 6 hours)
      const checkIntervalHours = parseInt(process.env.CHECK_INTERVAL_HOURS) || 6;
      const checkIntervalMs = checkIntervalHours * 60 * 60 * 1000;
      
      logger.info(`🔄 BMW ISTA Downloader läuft im Dauerbetrieb`);
      logger.info(`⏰ Update-Checks alle ${checkIntervalHours} Stunden (${checkIntervalMs / 1000 / 60} Minuten)`);
      
      // Run initial check
      logger.info('🚀 Führe ersten Update-Check durch...');
      await this.checkForUpdates();
      
      // Set up continuous operation
      while (true) {
        logger.info(`⏳ Warte ${checkIntervalHours} Stunden bis zum nächsten Update-Check...`);
        
        // Wait for the specified interval
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
        
        logger.info('🔄 Führe regelmäßigen Update-Check durch...');
        
        try {
          // Restart browser to prevent memory leaks
          logger.info('🔄 Starte Browser neu...');
          await this.cleanup();
          await this.launchBrowser();
          
          // Reset login status after browser restart
          this.isLoggedIn = false;
          
          await this.checkForUpdates();
        } catch (error) {
          logger.error(`❌ Fehler beim Update-Check: ${error.message}`);
          logger.info('🔄 Versuche es beim nächsten Intervall erneut...');
          
          // Ensure browser is cleaned up even if there's an error
          try {
            await this.cleanup();
          } catch (cleanupError) {
            logger.error(`❌ Fehler beim Aufräumen: ${cleanupError.message}`);
          }
        }
      }
      
    } catch (error) {
      logger.error(`❌ Kritischer Fehler: ${error.message}`);
      await this.cleanup();
      process.exit(1);
    }
  }
}

// Handle shutdown gracefully
const downloader = new BMWISTADownloader();

process.on('SIGINT', async () => {
  logger.info('\n👋 Beende BMW ISTA Downloader...');
  await downloader.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n👋 Beende BMW ISTA Downloader...');
  await downloader.cleanup();
  process.exit(0);
});

// Start the downloader
downloader.run();
