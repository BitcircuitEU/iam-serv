import { chromium } from 'playwright';
import winston from 'winston';
import cron from 'node-cron';
import fs from 'fs/promises';
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

class BMWDownloader {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.downloadDir = process.env.DOWNLOAD_DIR || './downloads';
    this.isLoggedIn = false;
    this.metadata = {};
    
    // Define specific download categories for each application
    this.downloadCategories = {
      'ista-p': {
        'installer': 'Installationsprogramm ISTA/P',
        'data_archive': 'Datenarchiv ISTA/P', 
        'ptd_driver': 'BMW PTD-Treiber'
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
    logger.info('🚀 BMW ISTA Downloader wird initialisiert...');
    
    // Create download directory and subdirectories
    await fs.mkdir(this.downloadDir, { recursive: true });
    await fs.mkdir(path.join(this.downloadDir, 'ista-p'), { recursive: true });
    await fs.mkdir(path.join(this.downloadDir, 'ista-next'), { recursive: true });
    
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
      // Configure downloads
      acceptDownloads: true,
      // Set download behavior
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
      
      // Wait for redirect - BMW now redirects to startpage-workshop after login
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
      const onStartpage = currentUrl.includes('startpage-workshop');
      
      // Extended verification - look for various indicators
      const loginIndicators = await this.page.evaluate(() => {
        const indicators = {
          url: window.location.href,
          hasLogoutLink: false,
          hasUserMenu: !!document.querySelector('.user-menu, .user-info, [class*="user"], [aria-label*="user"]'),
          hasNavigation: !!document.querySelector('.navigation-menu, nav, .main-navigation, .app-navigation'),
          hasApplications: !!document.querySelector('[class*="application"], [class*="app-tile"], [class*="card"]'),
          hasISTALinks: false,
          hasAlleAnwendungen: false,
          pageTitle: document.title,
          bodyContent: document.body.innerText.substring(0, 200)
        };
        
        // Check for logout links (pure JavaScript, no Playwright selectors)
        const logoutElements = document.querySelectorAll('a[href*="logout"], button, span, div');
        for (const elem of logoutElements) {
          const text = elem.textContent?.toLowerCase() || '';
          if (text.includes('logout') || text.includes('abmelden') || text.includes('sign out')) {
            indicators.hasLogoutLink = true;
            break;
          }
        }
        
        // Check for ISTA links
        const istaElements = document.querySelectorAll('a[href*="ista"], button, span, div');
        for (const elem of istaElements) {
          const text = elem.textContent?.toLowerCase() || '';
          if (text.includes('ista')) {
            indicators.hasISTALinks = true;
            break;
          }
        }
        
        // Check for "Alle Anwendungen"
        const alleAnwendungenElements = document.querySelectorAll('a, button, span, div, .nav-item');
        for (const elem of alleAnwendungenElements) {
          const text = elem.textContent?.trim() || '';
          if (text === 'Alle Anwendungen') {
            indicators.hasAlleAnwendungen = true;
            break;
          }
        }
        
        // Count how many indicators we found
        indicators.count = [
          indicators.hasLogoutLink,
          indicators.hasUserMenu,
          indicators.hasNavigation,
          indicators.hasApplications,
          indicators.hasISTALinks,
          indicators.hasAlleAnwendungen
        ].filter(Boolean).length;
        
        return indicators;
      });
      
      // Log what we found for debugging
      if (process.env.DEBUG === 'true') {
        logger.debug('Login-Indikatoren:');
        logger.debug(`  URL: ${loginIndicators.url}`);
        logger.debug(`  Logout-Link: ${loginIndicators.hasLogoutLink}`);
        logger.debug(`  User-Menu: ${loginIndicators.hasUserMenu}`);
        logger.debug(`  Navigation: ${loginIndicators.hasNavigation}`);
        logger.debug(`  Applications: ${loginIndicators.hasApplications}`);
        logger.debug(`  ISTA-Links: ${loginIndicators.hasISTALinks}`);
        logger.debug(`  Alle Anwendungen: ${loginIndicators.hasAlleAnwendungen}`);
        logger.debug(`  Seitentitel: ${loginIndicators.pageTitle}`);
        logger.debug(`  Gefundene Indikatoren: ${loginIndicators.count}/6`);
      }
      
      // We're logged in if we're on the startpage or have at least 2 indicators
      // "Alle Anwendungen" is a strong indicator of successful login
      if (onStartpage || loginIndicators.hasAlleAnwendungen || loginIndicators.count >= 2) {
        this.isLoggedIn = true;
        logger.info('✅ Login erfolgreich!');
      } else if (currentUrl.includes('aos.bmwgroup.com')) {
        // We're on BMW site but can't verify login - assume success if no auth redirect
        this.isLoggedIn = true;
        logger.info('✅ Login wahrscheinlich erfolgreich (auf BMW-Seite)');
      } else {
        throw new Error(`Login verification unsicher - URL: ${currentUrl}, Indikatoren: ${loginIndicators.count}/6`);
      }
      
      // Handle cookie banner if present
      await this.handleCookieBanner();
      
      return true;
    } catch (error) {
      logger.error(`❌ Login fehlgeschlagen: ${error.message}`);
      return false;
    }
  }

  async handleCookieBanner() {
    try {
      // Try multiple selectors for cookie banner
      const cookieSelectors = [
        'button:has-text("OK")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Accept")',
        '.cookie-banner button.ds-button--primary',
        '[class*="cookie"] button'
      ];

      for (const selector of cookieSelectors) {
        try {
          const button = await this.page.locator(selector).first();
          if (await button.isVisible({ timeout: 3000 })) {
            await button.click();
            logger.info('✅ Cookie-Banner akzeptiert');
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
    } catch (error) {
      logger.debug('Cookie-Banner nicht gefunden oder bereits akzeptiert');
    }
  }

  async navigateToApplication(appType) {
    logger.debug(`Versuche Navigation zu ${appType}...`);
    
    try {
      // Wait for the page to be fully loaded first
      await this.page.waitForLoadState('networkidle');
      
      // First try: Look for "Alle Anwendungen" link and click it
      try {
        const alleAnwendungenLink = await this.page.locator('a:has-text("Alle Anwendungen"), button:has-text("Alle Anwendungen"), [aria-label*="Alle Anwendungen"]').first();
        if (await alleAnwendungenLink.isVisible({ timeout: 5000 })) {
          logger.debug('Gefunden: "Alle Anwendungen" Link');
          await alleAnwendungenLink.click();
          await this.page.waitForLoadState('networkidle');
          await this.page.waitForTimeout(3000); // Wait for applications to load
          
          // Debug: Log what we see after clicking "Alle Anwendungen"
          if (process.env.DEBUG === 'true') {
            const pageContent = await this.page.evaluate(() => {
              return {
                title: document.title,
                url: window.location.href,
                bodyText: document.body.innerText.substring(0, 1000),
                allText: Array.from(document.querySelectorAll('*')).map(el => el.textContent?.trim()).filter(t => t && t.length > 0).slice(0, 20)
              };
            });
            logger.debug(`Nach "Alle Anwendungen" Klick:`);
            logger.debug(`  URL: ${pageContent.url}`);
            logger.debug(`  Titel: ${pageContent.title}`);
            logger.debug(`  Erste 1000 Zeichen: ${pageContent.bodyText.substring(0, 500)}...`);
            logger.debug(`  Erste 20 Textelemente: ${pageContent.allText.join(', ')}`);
          }
        }
      } catch (e) {
        logger.debug('"Alle Anwendungen" Link nicht gefunden, versuche direkte Suche');
      }

      // Look for application tiles/cards with the correct names
      const appName = appType === 'ista-p' ? 'ISTA Werkstattsystem' : 'E-Baureihen Programmierung';
      const tileSelectors = [
        // Specific application selectors
        `div:has-text("${appName}")`,
        `a:has-text("${appName}")`,
        `button:has-text("${appName}")`,
        `span:has-text("${appName}")`,
        `h1:has-text("${appName}")`,
        `h2:has-text("${appName}")`,
        `h3:has-text("${appName}")`,
        `h4:has-text("${appName}")`,
        `h5:has-text("${appName}")`,
        `h6:has-text("${appName}")`,
        // Generic application selectors
        `.application-tile:has-text("${appName}")`,
        `.app-card:has-text("${appName}")`,
        `.app-tile:has-text("${appName}")`,
        `.card:has-text("${appName}")`,
        `.tile:has-text("${appName}")`,
        `div[class*="tile"]:has-text("${appName}")`,
        `div[class*="card"]:has-text("${appName}")`,
        `div[class*="app"]:has-text("${appName}")`,
        `[aria-label*="${appName}"]`,
        `[title*="${appName}"]`,
        // Also try with partial matches for ISTA Werkstattsystem
        ...(appType === 'ista-p' ? [
          `div:has-text("ISTA Werkstattsystem")`,
          `a:has-text("ISTA Werkstattsystem")`,
          `button:has-text("ISTA Werkstattsystem")`,
          `span:has-text("ISTA Werkstattsystem")`,
          `div:has-text("ISTA")`,
          `a:has-text("ISTA")`,
          `button:has-text("ISTA")`,
          `span:has-text("ISTA")`,
          `div:has-text("Werkstattsystem")`,
          `a:has-text("Werkstattsystem")`,
          `button:has-text("Werkstattsystem")`,
          `span:has-text("Werkstattsystem")`
        ] : [
          `div:has-text("E-Baureihen Programmierung")`,
          `a:has-text("E-Baureihen Programmierung")`,
          `button:has-text("E-Baureihen Programmierung")`,
          `span:has-text("E-Baureihen Programmierung")`,
          `div:has-text("E-Baureihen")`,
          `a:has-text("E-Baureihen")`,
          `button:has-text("E-Baureihen")`,
          `span:has-text("E-Baureihen")`,
          `div:has-text("Programmierung")`,
          `a:has-text("Programmierung")`,
          `button:has-text("Programmierung")`,
          `span:has-text("Programmierung")`
        ])
      ];

      logger.debug(`Suche nach ${appName} mit ${tileSelectors.length} verschiedenen Selektoren...`);

      for (const selector of tileSelectors) {
        try {
          const elements = await this.page.locator(selector).all();
          logger.debug(`Selector "${selector}" gefunden: ${elements.length} Elemente`);
          
          for (const element of elements) {
            if (await element.isVisible({ timeout: 2000 })) {
              const text = await element.textContent();
              logger.debug(`Gefunden: "${text}" mit Selector ${selector}`);
              
                             // Check if this is the right application
               const isCorrectApp = appType === 'ista-p' 
                 ? (text.toLowerCase().includes('ista werkstattsystem') || text.toLowerCase().includes('werkstattsystem'))
                 : (text.toLowerCase().includes('e-baureihen programmierung') || text.toLowerCase().includes('e-baureihen') || text.toLowerCase().includes('programmierung'));
               
               if (isCorrectApp) {
                logger.debug(`Klicke auf "${text}" (${selector})`);
                await element.click();
                await this.page.waitForLoadState('networkidle');
                await this.page.waitForTimeout(3000); // Wait for page to load
                
                                 // Check if we're on a page with downloads
                 const currentUrl = this.page.url();
                 logger.debug(`Nach Klick URL: ${currentUrl}`);
                 
                 // Only consider successful if we're actually on the application page
                 if (currentUrl.includes(`/applications/${appType}`) || currentUrl.includes('ista') && !currentUrl.includes('startpage-workshop')) {
                   logger.info(`✅ Erfolgreich zu ${appType} navigiert`);
                   return true;
                 } else {
                   logger.debug(`Navigation nicht erfolgreich - noch auf: ${currentUrl}`);
                 }
              }
            }
          }
        } catch (e) {
          logger.debug(`Selector "${selector}" fehlgeschlagen: ${e.message}`);
          // Continue to next selector
        }
      }

      // Second try: Look for navigation menu items
      const navigationSelectors = [
        `a:has-text("${appType}")`,
        `a:has-text("${appType.toUpperCase()}")`,
        `button:has-text("${appType}")`,
        `[aria-label*="${appType}"]`,
        `.navigation-item:has-text("${appType}")`,
        `.menu-item:has-text("${appType}")`
      ];

      for (const selector of navigationSelectors) {
        try {
          const navItem = await this.page.locator(selector).first();
          if (await navItem.isVisible({ timeout: 2000 })) {
            logger.debug(`Gefunden: Navigation-Element mit Selector ${selector}`);
            await navItem.click();
            await this.page.waitForLoadState('networkidle');
            
            // Check if we navigated to the right place
            const currentUrl = this.page.url();
            if (currentUrl.includes(appType.replace('/', '').toLowerCase())) {
              logger.info(`✅ Erfolgreich zu ${appType} navigiert`);
              return true;
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      logger.warn(`Konnte nicht zu ${appType} navigieren`);
      return false;
    } catch (error) {
      logger.error(`Fehler bei Navigation zu ${appType}: ${error.message}`);
      return false;
    }
  }

  async getDownloads(url, appType) {
    logger.info(`📥 Hole Downloads für ${appType}...`);
    
    try {
      // First check if we're on the startpage
      const currentUrl = this.page.url();
      let navigationSuccess = false;
      
      if (currentUrl.includes('startpage-workshop')) {
        logger.debug('Auf Startseite - versuche Navigation über UI...');
        navigationSuccess = await this.navigateToApplication(appType);
        
        if (!navigationSuccess) {
          logger.debug('Navigation über UI fehlgeschlagen - verwende direkte URL');
        }
      }
      
             // If navigation didn't work, try direct URL
       if (!navigationSuccess) {
         logger.debug(`Navigation über UI fehlgeschlagen - versuche direkte URL: ${url}`);
         try {
           await this.page.goto(url, {
             waitUntil: 'networkidle',
             timeout: 60000
           });
           
           // Check if we successfully navigated to the application page
           const currentUrl = this.page.url();
           logger.debug(`Direkte URL Navigation - aktuelle URL: ${currentUrl}`);
           
           // More specific check for the correct application
           if (currentUrl.includes(`/applications/${appType}`)) {
             logger.info(`✅ Erfolgreich zu ${appType} über direkte URL navigiert`);
             navigationSuccess = true;
           } else if (currentUrl.includes('ista') && !currentUrl.includes('startpage-workshop')) {
             // We're on an ISTA page, but let's verify it's the right one
             logger.info(`✅ Auf ISTA-Seite gelandet: ${currentUrl}`);
             navigationSuccess = true;
           } else {
             logger.warn(`Direkte URL Navigation fehlgeschlagen - aktuelle URL: ${currentUrl}`);
           }
         } catch (error) {
           logger.error(`❌ Fehler bei direkter URL Navigation: ${error.message}`);
         }
       }
      
      if (!navigationSuccess) {
        logger.error(`❌ Konnte nicht zu ${appType} navigieren`);
        return {};
      }

      // Log current URL for debugging
      const finalUrl = this.page.url();
      logger.debug(`Aktuelle URL nach Navigation: ${finalUrl}`);

      // Check if we need to handle any redirects or authentication
      if (finalUrl.includes('auth.bmwgroup.com')) {
        logger.warn('Wurde zur Authentifizierung umgeleitet - Login-Session abgelaufen?');
        this.isLoggedIn = false;
        return {};
      }

      // Wait for the page to be fully loaded
      await this.page.waitForLoadState('domcontentloaded');
      
      // Wait for Angular application to load completely
      logger.debug('Warte auf Angular-App...');
      
      // Wait for Angular to be ready
      try {
        await this.page.waitForFunction(() => {
          // Check if Angular is loaded
          return window.ng !== undefined || 
                 document.querySelector('app-root') !== null ||
                 document.querySelector('#app') !== null;
        }, { timeout: 30000 });
        logger.debug('Angular-App erkannt');
      } catch (e) {
        logger.warn('Angular-App nicht erkannt, fahre trotzdem fort');
      }
      
                    // Wait for any download-related elements to appear (including frames)
       logger.debug('Warte auf Download-Bereich...');
       let downloadAreaFound = false;
       
       try {
         // First wait for frames to load
         logger.debug('Warte auf Frames...');
         try {
           await this.page.waitForFunction(() => {
             const frames = document.querySelectorAll('iframe');
             return frames.length > 0;
           }, { timeout: 10000 });
           logger.debug('Frames gefunden, warte auf Frame-Inhalt...');
           
           // Wait for frame content to load
           await this.page.waitForFunction(() => {
             const frames = document.querySelectorAll('iframe');
             for (const frame of frames) {
               try {
                 const frameDoc = frame.contentDocument || frame.contentWindow?.document;
                 if (frameDoc && frameDoc.readyState === 'complete') {
                   return true;
                 }
               } catch (e) {
                 // Frame might be cross-origin
               }
             }
             return false;
           }, { timeout: 15000 });
           logger.debug('Frame-Inhalt geladen');
         } catch (e) {
           logger.debug('Keine Frames gefunden oder Frame-Inhalt nicht zugänglich');
         }
         
         // Try multiple selectors for download areas (in main page and frames)
         const downloadSelectors = [
           '#downloadsPortlet',
           '[id*="download"]',
           '[class*="download"]',
           '[class*="Download"]',
           '[data-testid*="download"]',
           'section[aria-label*="download"]',
           'div[role="region"][aria-label*="download"]',
           '.downloads-container',
           '.download-section',
           '[class*="portlet"]'
         ];
         
         for (const selector of downloadSelectors) {
           try {
             await this.page.waitForSelector(selector, { timeout: 5000 });
             logger.debug(`Download-Bereich gefunden mit Selector: ${selector}`);
             downloadAreaFound = true;
             break;
           } catch (e) {
             // Continue to next selector
           }
         }
         
         if (!downloadAreaFound) {
           // Try to find any element with download-related text (including in frames)
           await this.page.waitForFunction(() => {
             const downloadKeywords = ['download', 'herunterladen', 'install', 'installation', 'client', 'firmware', 'treiber', 'driver'];
             
             // Check main document
             const allElements = document.querySelectorAll('*');
             for (const elem of allElements) {
               const text = elem.textContent?.toLowerCase() || '';
               if (downloadKeywords.some(keyword => text.includes(keyword))) {
                 return true;
               }
             }
             
             // Check frames
             const frames = document.querySelectorAll('iframe');
             for (const frame of frames) {
               try {
                 const frameDoc = frame.contentDocument || frame.contentWindow?.document;
                 if (frameDoc) {
                   const frameElements = frameDoc.querySelectorAll('*');
                   for (const elem of frameElements) {
                     const text = elem.textContent?.toLowerCase() || '';
                     if (downloadKeywords.some(keyword => text.includes(keyword))) {
                       return true;
                     }
                   }
                 }
               } catch (e) {
                 // Frame might be cross-origin
               }
             }
             
             return false;
           }, { timeout: 10000 });
           logger.debug('Download-Keywords auf der Seite oder in Frames gefunden');
           downloadAreaFound = true;
         }
         
         // Additional wait to ensure the page is fully loaded
         await this.page.waitForTimeout(3000);
        
       } catch (e) {
         logger.warn('Download-Bereich nicht gefunden, versuche trotzdem Downloads zu extrahieren');
         
         // Take a screenshot for debugging
         if (process.env.DEBUG === 'true') {
           const screenshotPath = `debug_${appType}_no_downloads_${Date.now()}.png`;
           await this.page.screenshot({ path: screenshotPath, fullPage: true });
           logger.debug(`Screenshot gespeichert: ${screenshotPath}`);
         }
       }

      // Additional wait for dynamic content
      await this.page.waitForTimeout(2000);

             // Execute JavaScript in the page context to find downloads (including frames)
       const pageAnalysis = await this.page.evaluate(() => {
         const analysis = {
           downloads: [],
           pageInfo: {
             title: document.title,
             url: window.location.href,
             hasAngular: typeof window.ng !== 'undefined',
             hasReact: typeof window.React !== 'undefined',
             allLinks: [],
             downloadSections: [],
             frames: []
           }
         };
         
         // Function to analyze a document (main page or frame)
         function analyzeDocument(doc, frameInfo = 'main') {
           const frameAnalysis = {
             title: doc.title,
             url: doc.location?.href || 'unknown',
             links: [],
             downloads: [],
             downloadSections: []
           };
           
           // Collect ALL links for debugging
           doc.querySelectorAll('a[href]').forEach(link => {
             const href = link.href;
             const text = link.textContent.trim();
             if (href && text) {
               frameAnalysis.links.push({ href, text });
               analysis.pageInfo.allLinks.push({ href, text, frame: frameInfo });
             }
           });
           
           // Method 1: Find all links with download-related patterns
           const downloadPatterns = [
             'a[href*="/api/v2/downloads"]',
             'a[href*="/api/v1/downloads"]',
             'a[href*="/download"]',
             'a[href*=".exe"]',
             'a[href*=".zip"]',
             'a[href*=".msi"]',
             'a[href*=".istapdata"]',
             'a[href*="ISTA"]',
             'a[href*="download"]',
             'a[href*="Download"]',
             'button',
             'input[type="button"]',
             '.download-link',
             '[class*="download"]',
             '[class*="Download"]'
           ];
           
           downloadPatterns.forEach(pattern => {
             try {
               const elements = doc.querySelectorAll(pattern);
               elements.forEach(elem => {
                 const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href') || elem.getAttribute('onclick');
                 const text = elem.textContent.trim() || elem.getAttribute('aria-label') || elem.getAttribute('title') || elem.value;
                 
                 if (href && text) {
                   frameAnalysis.downloads.push({
                     title: text,
                     url: href,
                     method: `selector: ${pattern}`,
                     frame: frameInfo
                   });
                 }
               });
             } catch (e) {
               // Selector might not be valid for all browsers
             }
           });
           
           // Method 1.5: Look for any element with download-related text
           const allElements = doc.querySelectorAll('*');
           allElements.forEach(elem => {
             const text = elem.textContent?.trim() || '';
             const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href');
             
             // Check if text contains download-related keywords
             const downloadKeywords = ['download', 'herunterladen', 'install', 'installation', 'client', 'firmware', 'treiber', 'driver'];
             const hasDownloadKeyword = downloadKeywords.some(keyword => 
               text.toLowerCase().includes(keyword.toLowerCase())
             );
             
             if (hasDownloadKeyword && href && text.length > 0 && text.length < 200) {
               frameAnalysis.downloads.push({
                 title: text,
                 url: href,
                 method: 'keyword_search',
                 frame: frameInfo
               });
             }
           });
           
                       // Method 2: Look for specific sections/containers
            const containerSelectors = [
              '#downloadsPortlet',
              '[id*="download"]',
              '[class*="download"]',
              '[class*="Download"]',
              '[data-testid*="download"]',
              'section[aria-label*="download"]',
              'div[role="region"][aria-label*="download"]',
              '.downloads-container',
              '.download-section',
              '[class*="portlet"]',
              'div[data-downloads]',
              'section[aria-label*="download"]',
              '[class*="content"]',
              '[class*="main"]',
              '[class*="body"]'
            ];
            
            containerSelectors.forEach(selector => {
              try {
                const containers = doc.querySelectorAll(selector);
                containers.forEach(container => {
                  frameAnalysis.downloadSections.push(selector);
                  
                  // Look for any links within the container
                  const links = container.querySelectorAll('a[href]');
                  links.forEach(link => {
                    const href = link.href;
                    const text = link.textContent.trim();
                    
                    if (href && text && !frameAnalysis.downloads.find(d => d.url === href)) {
                      frameAnalysis.downloads.push({
                        title: text,
                        url: href,
                        method: `container: ${selector}`,
                        frame: frameInfo
                      });
                    }
                  });
                  
                  // Also look for buttons and other clickable elements
                  const buttons = container.querySelectorAll('button, input[type="button"], [role="button"], [onclick]');
                  buttons.forEach(button => {
                    const text = button.textContent?.trim() || button.value || button.getAttribute('aria-label') || button.getAttribute('title') || '';
                    const onclick = button.getAttribute('onclick');
                    
                    if (text && onclick && !frameAnalysis.downloads.find(d => d.title === text)) {
                      frameAnalysis.downloads.push({
                        title: text,
                        url: onclick,
                        method: `container_button: ${selector}`,
                        frame: frameInfo
                      });
                    }
                  });
                });
              } catch (e) {
                // Skip invalid selectors
              }
            });
           
                       // Method 2.5: Special search for Download section by finding elements with "Download" text
            const downloadElements = doc.querySelectorAll('*');
            downloadElements.forEach(elem => {
              const text = elem.textContent?.trim() || '';
              
              // Check if this element contains "Download" (case insensitive)
              if (text.toLowerCase().includes('download')) {
                // Find the parent container that might contain download links
                let container = elem;
                for (let i = 0; i < 5; i++) { // Go up 5 levels max
                  if (container && container !== doc.body && container.parentElement) {
                    // Look for links within this container
                    const links = container.querySelectorAll('a[href]');
                    links.forEach(link => {
                      const href = link.href;
                      const linkText = link.textContent.trim();
                      
                      // Skip footer/header links
                      if (href && linkText && 
                          !href.includes('technical-requirements') && 
                          !href.includes('conditions-of-use') && 
                          !href.includes('data-privacy') && 
                          !href.includes('imprint') && 
                          !href.includes('price-list') && 
                          !href.includes('cookies') && 
                          !href.includes('user-guide') && 
                          !href.includes('getting-started') &&
                          !frameAnalysis.downloads.find(d => d.url === href)) {
                        frameAnalysis.downloads.push({
                          title: linkText,
                          url: href,
                          method: `download_section_search`,
                          frame: frameInfo
                        });
                      }
                    });
                    
                    // Also look for buttons
                    const buttons = container.querySelectorAll('button, input[type="button"], [role="button"], [onclick]');
                    buttons.forEach(button => {
                      const buttonText = button.textContent?.trim() || button.value || button.getAttribute('aria-label') || button.getAttribute('title') || '';
                      const onclick = button.getAttribute('onclick');
                      
                      if (buttonText && onclick && !frameAnalysis.downloads.find(d => d.title === buttonText)) {
                        frameAnalysis.downloads.push({
                          title: buttonText,
                          url: onclick,
                          method: `download_section_button`,
                          frame: frameInfo
                        });
                      }
                    });
                  }
                  // Safely move to parent element
                  if (container && container.parentElement) {
                    container = container.parentElement;
                  } else {
                    break; // Stop if no parent element
                  }
                }
              }
            });
           
           return frameAnalysis;
         }
         
         // Analyze main document
         const mainAnalysis = analyzeDocument(document, 'main');
         analysis.downloads.push(...mainAnalysis.downloads);
         analysis.pageInfo.downloadSections.push(...mainAnalysis.downloadSections);
         
         // Analyze all frames
         const frames = document.querySelectorAll('iframe');
         frames.forEach((frame, index) => {
           try {
             const frameDoc = frame.contentDocument || frame.contentWindow?.document;
             if (frameDoc) {
               const frameAnalysis = analyzeDocument(frameDoc, `frame_${index}`);
               analysis.downloads.push(...frameAnalysis.downloads);
               analysis.pageInfo.downloadSections.push(...frameAnalysis.downloadSections);
               analysis.pageInfo.frames.push({
                 index,
                 src: frame.src,
                 title: frameAnalysis.title,
                 url: frameAnalysis.url,
                 links: frameAnalysis.links.length,
                 downloads: frameAnalysis.downloads.length
               });
             }
           } catch (e) {
             // Frame might be cross-origin and inaccessible
             analysis.pageInfo.frames.push({
               index,
               src: frame.src,
               accessible: false,
               error: e.message
             });
           }
         });
        
        // Collect ALL links for debugging
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href;
          const text = link.textContent.trim();
          if (href && text) {
            analysis.pageInfo.allLinks.push({ href, text });
          }
        });

        // Method 1: Find all links with download-related patterns (pure JavaScript)
        const downloadPatterns = [
          'a[href*="/api/v2/downloads"]',
          'a[href*="/api/v1/downloads"]',
          'a[href*="/download"]',
          'a[href*=".exe"]',
          'a[href*=".zip"]',
          'a[href*=".msi"]',
          'a[href*=".istapdata"]',
          'a[href*="ISTA"]',
          'a[href*="download"]',
          'a[href*="Download"]',
          'button',
          'input[type="button"]',
          '.download-link',
          '[class*="download"]',
          '[class*="Download"]'
        ];
        
        downloadPatterns.forEach(pattern => {
          try {
            const elements = document.querySelectorAll(pattern);
            elements.forEach(elem => {
              const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href') || elem.getAttribute('onclick');
              const text = elem.textContent.trim() || elem.getAttribute('aria-label') || elem.getAttribute('title') || elem.value;
              
              if (href && text) {
                analysis.downloads.push({
                  title: text,
                  url: href,
                  method: `selector: ${pattern}`
                });
              }
            });
          } catch (e) {
            // Selector might not be valid for all browsers
          }
        });

        // Method 1.5: Look for any element with download-related text
        const allElements = document.querySelectorAll('*');
        allElements.forEach(elem => {
          const text = elem.textContent?.trim() || '';
          const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href');
          
          // Check if text contains download-related keywords
          const downloadKeywords = ['download', 'herunterladen', 'install', 'installation', 'client', 'firmware', 'treiber', 'driver'];
          const hasDownloadKeyword = downloadKeywords.some(keyword => 
            text.toLowerCase().includes(keyword.toLowerCase())
          );
          
          if (hasDownloadKeyword && href && text.length > 0 && text.length < 200) {
            analysis.downloads.push({
              title: text,
              url: href,
              method: 'keyword_search'
            });
          }
        });

                           // Method 2: Look for specific sections/containers (expanded search)
          const containerSelectors = [
            '#downloadsPortlet',
            '[id*="download"]',
            '[class*="download"]',
            '[class*="Download"]',
            '[data-testid*="download"]',
            'section[aria-label*="download"]',
            'div[role="region"][aria-label*="download"]',
            '.downloads-container',
            '.download-section',
            '[class*="portlet"]',
            'div[data-downloads]',
            'section[aria-label*="download"]',
            // More specific selectors
            '[class*="content"]',
            '[class*="main"]',
            '[class*="body"]'
          ];
          
          containerSelectors.forEach(selector => {
            try {
              const containers = document.querySelectorAll(selector);
              containers.forEach(container => {
                analysis.pageInfo.downloadSections.push(selector);
                
                // Look for any links within the container
                const links = container.querySelectorAll('a[href]');
                links.forEach(link => {
                  const href = link.href;
                  const text = link.textContent.trim();
                  
                  if (href && text && !analysis.downloads.find(d => d.url === href)) {
                    analysis.downloads.push({
                      title: text,
                      url: href,
                      method: `container: ${selector}`
                    });
                  }
                });
                
                // Also look for buttons and other clickable elements
                const buttons = container.querySelectorAll('button, input[type="button"], [role="button"], [onclick]');
                buttons.forEach(button => {
                  const text = button.textContent?.trim() || button.value || button.getAttribute('aria-label') || button.getAttribute('title') || '';
                  const onclick = button.getAttribute('onclick');
                  
                  if (text && onclick && !analysis.downloads.find(d => d.title === text)) {
                    analysis.downloads.push({
                      title: text,
                      url: onclick,
                      method: `container_button: ${selector}`
                    });
                  }
                });
              });
            } catch (e) {
              // Skip invalid selectors
            }
          });
         
                   // Method 2.5: Special search for Download section by finding elements with "Download" text
          const downloadElements = document.querySelectorAll('*');
          downloadElements.forEach(elem => {
            const text = elem.textContent?.trim() || '';
            
            // Check if this element contains "Download" (case insensitive)
            if (text.toLowerCase().includes('download')) {
              // Find the parent container that might contain download links
              let container = elem;
              for (let i = 0; i < 5; i++) { // Go up 5 levels max
                if (container && container !== document.body && container.parentElement) {
                  // Look for links within this container
                  const links = container.querySelectorAll('a[href]');
                  links.forEach(link => {
                    const href = link.href;
                    const linkText = link.textContent.trim();
                    
                    // Skip footer/header links
                    if (href && linkText && 
                        !href.includes('technical-requirements') && 
                        !href.includes('conditions-of-use') && 
                        !href.includes('data-privacy') && 
                        !href.includes('imprint') && 
                        !href.includes('price-list') && 
                        !href.includes('cookies') && 
                        !href.includes('user-guide') && 
                        !href.includes('getting-started') &&
                        !analysis.downloads.find(d => d.url === href)) {
                      analysis.downloads.push({
                        title: linkText,
                        url: href,
                        method: `download_section_search`
                      });
                    }
                  });
                  
                  // Also look for buttons
                  const buttons = container.querySelectorAll('button, input[type="button"], [role="button"], [onclick]');
                  buttons.forEach(button => {
                    const buttonText = button.textContent?.trim() || button.value || button.getAttribute('aria-label') || button.getAttribute('title') || '';
                    const onclick = button.getAttribute('onclick');
                    
                    if (buttonText && onclick && !analysis.downloads.find(d => d.title === buttonText)) {
                      analysis.downloads.push({
                        title: buttonText,
                        url: onclick,
                        method: `download_section_button`
                      });
                    }
                  });
                }
                // Safely move to parent element
                if (container && container.parentElement) {
                  container = container.parentElement;
                } else {
                  break; // Stop if no parent element
                }
              }
            }
          });

        // Method 3: Check Angular/React component data
        if (window.ng && typeof window.ng.getComponent === 'function') {
          try {
            const appRoot = document.querySelector('app-root');
            if (appRoot) {
              const component = window.ng.getComponent(appRoot);
              if (component && component.downloads) {
                component.downloads.forEach(dl => {
                  analysis.downloads.push({
                    title: dl.title || dl.name,
                    url: dl.url || dl.downloadUrl,
                    version: dl.version,
                    method: 'angular_component'
                  });
                });
              }
            }
          } catch (e) {
            console.error('Angular component access failed:', e);
          }
        }

                 // Method 4: Look for any clickable elements with download-related text
         const clickableElements = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"], [onclick]');
         clickableElements.forEach(elem => {
           const text = elem.textContent?.trim() || elem.value || elem.getAttribute('aria-label') || elem.getAttribute('title') || '';
           const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href');
           const onclick = elem.getAttribute('onclick');
           
           // Check for download-related text patterns
           const downloadPatterns = [
             /download/i,
             /herunterladen/i,
             /install/i,
             /installation/i,
             /client/i,
             /firmware/i,
             /treiber/i,
             /driver/i,
             /\.exe/i,
             /\.zip/i,
             /\.msi/i
           ];
           
           const hasDownloadPattern = downloadPatterns.some(pattern => 
             pattern.test(text) || pattern.test(href) || pattern.test(onclick)
           );
           
           if (hasDownloadPattern && (href || onclick) && text.length > 0) {
             analysis.downloads.push({
               title: text,
               url: href || onclick,
               method: 'clickable_element'
             });
           }
         });
         
                   // Method 5: Look for any visible elements with download-related text (most comprehensive)
          const visibleElements = document.querySelectorAll('*');
          visibleElements.forEach(elem => {
           // Check if element is visible
           const style = window.getComputedStyle(elem);
           if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
             return; // Skip hidden elements
           }
           
           const text = elem.textContent?.trim() || '';
           const href = elem.href || elem.getAttribute('data-href') || elem.getAttribute('ng-href');
           const onclick = elem.getAttribute('onclick');
           
           // Check for download-related keywords
           const downloadKeywords = [
             'download', 'herunterladen', 'install', 'installation', 'client', 'firmware', 'treiber', 'driver',
             'exe', 'zip', 'msi', 'istapdata', 'bdrclient', 'istaoss', 'programmingdata'
           ];
           
           const hasDownloadKeyword = downloadKeywords.some(keyword => 
             text.toLowerCase().includes(keyword.toLowerCase())
           );
           
           if (hasDownloadKeyword && (href || onclick) && text.length > 0 && text.length < 200) {
             analysis.downloads.push({
               title: text,
               url: href || onclick,
               method: 'visible_element_search'
             });
           }
         });

        return analysis;
      });

                      // Log page analysis for debugging
         if (process.env.DEBUG === 'true') {
           logger.debug(`Seiten-Analyse für ${appType}:`);
           logger.debug(`  Titel: ${pageAnalysis.pageInfo.title}`);
           logger.debug(`  URL: ${pageAnalysis.pageInfo.url}`);
           logger.debug(`  Gefundene Links: ${pageAnalysis.pageInfo.allLinks.length}`);
           logger.debug(`  Download-Sections: ${pageAnalysis.pageInfo.downloadSections.join(', ') || 'keine'}`);
           logger.debug(`  Rohe Downloads gefunden: ${pageAnalysis.downloads.length}`);
           
           // Log frame information
           if (pageAnalysis.pageInfo.frames.length > 0) {
             logger.debug('  Gefundene Frames:');
             pageAnalysis.pageInfo.frames.forEach((frame, index) => {
               if (frame.accessible) {
                 logger.debug(`    Frame ${index}: ${frame.title} (${frame.links} Links, ${frame.downloads} Downloads)`);
                 logger.debug(`      URL: ${frame.url}`);
               } else {
                 logger.debug(`    Frame ${index}: Nicht zugänglich (${frame.src})`);
                 logger.debug(`      Fehler: ${frame.error}`);
               }
             });
           } else {
             logger.debug('  Keine Frames gefunden');
           }
           
                       // Log all found downloads for debugging
            if (pageAnalysis.downloads.length > 0) {
              logger.debug('  Gefundene Downloads (roh):');
              pageAnalysis.downloads.forEach((download, index) => {
                logger.debug(`    ${index + 1}. ${download.title} (${download.method}) [${download.frame}]`);
                logger.debug(`       URL: ${download.url}`);
              });
            } else {
              logger.debug('  Keine Downloads gefunden');
            }
           
                       // Log all links for debugging
            if (pageAnalysis.pageInfo.allLinks.length > 0) {
              logger.debug('  Alle gefundenen Links:');
              pageAnalysis.pageInfo.allLinks.forEach((link, index) => {
                logger.debug(`    ${index + 1}. ${link.text}: ${link.href} [${link.frame}]`);
              });
            }
         }

      const downloads = pageAnalysis.downloads;

      // Filter and categorize downloads
      const categorizedDownloads = this.categorizeDownloads(downloads, appType);
      
             logger.info(`✅ ${Object.keys(categorizedDownloads).length} Downloads gefunden für ${appType}`);
       
               if (process.env.DEBUG === 'true') {
          logger.debug(`Kategorisierte Downloads für ${appType}:`);
          for (const [category, download] of Object.entries(categorizedDownloads)) {
            logger.debug(`  ${category}: ${download.displayName} (${download.method}) [${download.frame}]`);
            logger.debug(`    Original: ${download.title}`);
            logger.debug(`    URL: ${download.url}`);
            logger.debug(`    Version: ${download.version}`);
          }
        }

      return categorizedDownloads;
    } catch (error) {
      logger.error(`❌ Fehler beim Abrufen der Downloads für ${appType}: ${error.message}`);
      
      // Take screenshot for debugging
      if (process.env.DEBUG === 'true') {
        const screenshotPath = `debug_${appType}_${Date.now()}.png`;
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        logger.debug(`Screenshot gespeichert: ${screenshotPath}`);
      }
      
      return {};
    }
  }

  categorizeDownloads(downloads, appType) {
    const categorized = {};
    const validCategories = Object.keys(this.downloadCategories[appType] || {});
    
    logger.debug(`Suche nach Downloads für ${appType} in Kategorien: ${validCategories.join(', ')}`);
    
    for (const download of downloads) {
      const title = download.title.toLowerCase();
      const url = download.url.toLowerCase();
      let category = null;

      if (appType === 'ista-p') {
        // ISTA/P categorization - only look for specific categories
        if ((title.includes('installationsprogramm') || url.includes('bdrclient') || 
             title.includes('installationsdatei') || url.includes('istaoss')) && 
            validCategories.includes('installer')) {
          category = 'installer';
        } else if ((title.includes('datenarchiv') || url.includes('commondat') || url.includes('.istapdata') ||
                   title.includes('programmierdaten') || url.includes('programmingdata')) && 
                   validCategories.includes('data_archive')) {
          category = 'data_archive';
        } else if ((title.includes('ptd') || title.includes('treiber')) && 
                   validCategories.includes('ptd_driver')) {
          category = 'ptd_driver';
        }
      } else if (appType === 'ista-next') {
        // ISTA-Next categorization - only look for specific categories
        if ((title.includes('installationsdatei') || title.includes('client') || 
             (url.includes('istaoss') && url.includes('.zip'))) && 
            validCategories.includes('client')) {
          category = 'client';
        } else if ((title.includes('programmierdaten') || url.includes('programmingdata')) && 
                   validCategories.includes('programming_data')) {
          category = 'programming_data';
        } else if ((title.includes('icom') && title.includes('firmware')) && 
                   validCategories.includes('icom_firmware')) {
          category = 'icom_firmware';
        } else if ((title.includes('ptd') || title.includes('treiber')) && 
                   validCategories.includes('ptd_driver')) {
          category = 'ptd_driver';
        }
      }

      // Only keep relevant downloads that match our defined categories
      if (category && !categorized[category]) {
        categorized[category] = {
          ...download,
          category,
          appType,
          displayName: this.downloadCategories[appType][category],
          version: this.extractVersion(download.url)
        };
        
        logger.debug(`✅ Kategorisiert: ${download.title} -> ${category} (${this.downloadCategories[appType][category]})`);
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

  async downloadFile(download) {
    logger.info(`⬇️ Lade herunter: ${download.displayName || download.title}`);
    logger.debug(`   URL: ${download.url}`);
    
    try {
      // Create a new page for each download to avoid conflicts
      const downloadPage = await this.context.newPage();
      
      try {
        // Set up download event listener before navigation
        const downloadPromise = downloadPage.waitForEvent('download', { timeout: 300000 }); // 5 minutes timeout
        
        // Navigate to download URL with retry logic
        let downloadEvent;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            logger.debug(`   Versuch ${retryCount + 1}/${maxRetries}...`);
            
            // Navigate to download URL
            await downloadPage.goto(download.url, { 
              waitUntil: 'networkidle',
              timeout: 120000 // 2 minutes timeout
            });
            
            // Wait for download to start
            downloadEvent = await downloadPromise;
            break; // Success, exit retry loop
            
          } catch (navigationError) {
            retryCount++;
            logger.warn(`   Navigation fehlgeschlagen (Versuch ${retryCount}/${maxRetries}): ${navigationError.message}`);
            
            if (retryCount >= maxRetries) {
              throw navigationError;
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
        
        // Get the suggested filename
        const suggestedFilename = downloadEvent.suggestedFilename();
        logger.debug(`   Vorgeschlagener Dateiname: ${suggestedFilename}`);
        
        // Create a better filename if the suggested one is not good
        let fileName = suggestedFilename;
        if (!fileName || fileName === 'download' || fileName.length < 5) {
          // Extract filename from URL or create one based on download info
          const urlParts = download.url.split('/');
          const urlFilename = urlParts[urlParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            fileName = urlFilename;
          } else {
            // Create filename from download info
            const version = download.version !== 'unknown' ? `_${download.version}` : '';
            const extension = this.getFileExtension(download.url);
            fileName = `${download.category}${version}${extension}`;
          }
          logger.debug(`   Generierter Dateiname: ${fileName}`);
        }
        
        // Save the file in the appropriate subdirectory
        const subDir = download.appType || 'unknown';
        const filePath = path.join(this.downloadDir, subDir, fileName);
        
        logger.debug(`   Speichere Datei: ${filePath}`);
        
        // Save the file
        await downloadEvent.saveAs(filePath);
        
        // Verify file was actually downloaded
        try {
          const stats = await fs.stat(filePath);
          if (stats.size > 0) {
            logger.info(`✅ Download abgeschlossen: ${fileName} -> ${subDir}/ (${this.formatFileSize(stats.size)})`);
            
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
            logger.error(`❌ Download fehlgeschlagen: Datei ist leer (${fileName})`);
            // Try to delete empty file
            try {
              await fs.unlink(filePath);
            } catch (e) {
              // Ignore deletion errors
            }
            return false;
          }
        } catch (fsError) {
          logger.error(`❌ Download fehlgeschlagen: Datei konnte nicht verifiziert werden (${fileName}): ${fsError.message}`);
          return false;
        }
        
      } finally {
        // Always close the download page
        await downloadPage.close();
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
    if (urlLower.includes('.msi')) return '.msi';
    if (urlLower.includes('.istapdata')) return '.istapdata';
    if (urlLower.includes('.bin')) return '.bin';
    if (urlLower.includes('.iso')) return '.iso';
    return '.bin'; // Default extension
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }



  isNewVersion(category, version) {
    const lastVersion = this.metadata[category]?.version;
    
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

    const updates = [];

    // Check ISTA/P
    logger.info('📥 Prüfe ISTA/P Downloads...');
    const istaPDownloads = await this.getDownloads(process.env.BMW_ISTA_P_URL, 'ista-p');
    for (const [category, download] of Object.entries(istaPDownloads)) {
      const metadataKey = `ista-p_${category}`;
      if (this.isNewVersion(metadataKey, download.version)) {
        updates.push(download);
        logger.info(`🆕 Neue Version gefunden: ${download.displayName} (${download.version})`);
      } else {
        logger.info(`✅ Aktuelle Version bereits vorhanden: ${download.displayName} (${download.version})`);
      }
    }

    // Check ISTA-Next
    logger.info('📥 Prüfe ISTA-Next Downloads...');
    const istaNextDownloads = await this.getDownloads(process.env.BMW_ISTA_NEXT_URL, 'ista-next');
    for (const [category, download] of Object.entries(istaNextDownloads)) {
      const metadataKey = `ista-next_${category}`;
      if (this.isNewVersion(metadataKey, download.version)) {
        updates.push(download);
        logger.info(`🆕 Neue Version gefunden: ${download.displayName} (${download.version})`);
      } else {
        logger.info(`✅ Aktuelle Version bereits vorhanden: ${download.displayName} (${download.version})`);
      }
    }

    // Download updates sequentially to avoid rate limits
    if (updates.length > 0) {
      logger.info(`📥 ${updates.length} Updates werden sequenziell heruntergeladen...`);
      
      let successCount = 0;
      let failCount = 0;
      
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
          
          // Add delay between downloads to avoid rate limits
          if (i < updates.length - 1) {
            logger.info('⏳ Warte 3 Sekunden vor dem nächsten Download...');
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
        } catch (error) {
          logger.error(`❌ Fehler beim Download von ${update.displayName}: ${error.message}`);
          failCount++;
        }
      }
      
      logger.info(`📊 Download-Statistik: ${successCount} erfolgreich, ${failCount} fehlgeschlagen`);
      
    } else {
      logger.info('✅ Keine Updates verfügbar');
    }
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
      await this.checkForUpdates();
      
      // Schedule periodic checks
      if (process.env.CHECK_INTERVAL_HOURS) {
        const interval = parseInt(process.env.CHECK_INTERVAL_HOURS);
        logger.info(`⏰ Plane Update-Checks alle ${interval} Stunden`);
        
        cron.schedule(`0 */${interval} * * *`, async () => {
          logger.info('⏰ Geplanter Update-Check startet...');
          await this.checkForUpdates();
        });
        
        // Keep the process running
        logger.info('🏃 BMW Downloader läuft... (Drücke Ctrl+C zum Beenden)');
      } else {
        // One-time run
        await this.cleanup();
      }
    } catch (error) {
      logger.error(`❌ Kritischer Fehler: ${error.message}`);
      await this.cleanup();
      process.exit(1);
    }
  }
}

// Handle shutdown gracefully
const downloader = new BMWDownloader();

process.on('SIGINT', async () => {
  logger.info('\n👋 Beende BMW Downloader...');
  await downloader.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await downloader.cleanup();
  process.exit(0);
});

// Start the downloader
downloader.run();
