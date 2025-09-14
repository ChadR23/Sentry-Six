/**
 * Sentry-Six Electron Renderer
 * Main application logic for the frontend
 */

class SentrySixApp {
    constructor() {
        this.currentClipGroup = null;
        this.clipSections = {};
        this.currentTimeline = null;
        this.isPlaying = false;
        this.currentTime = 0;
        this.duration = 0;
        this.volume = 1;
        this.playbackSpeed = 1;
        this.isMuted = false;
        this.currentClipIndex = 0;
        this.clipGroups = [];
        this.eventMarkers = [];
        this.eventMarkersCache = {}; // Cache for lazy-loaded event markers per date
        this.debugManager = null;
        this.exportDialog = null;
        this.durationLoadingIndicator = null;
        
        // New properties for background duration processing
        this.durationProcessingStatus = {}; // Track processing status for each date
        this.isProcessingDurations = false; // Global processing flag
        this.durationProcessingQueue = []; // Queue of dates to process
        this.currentlyProcessingDate = null; // Currently processing date
        this.zeroProbeOnLoad = false; // Probe on folder load; cache-complete dates are skipped
        
        // Camera zoom and pan properties
        this.cameraZoomLevels = {}; // Store zoom levels for each camera
        this.cameraPanOffsets = {}; // Store pan offsets for each camera
        this.cameraVisibility = {
            left_pillar: true,
            front: true,
            right_pillar: true,
            left_repeater: true,
            back: true,
            right_repeater: true
        };
        
        // Video players storage
        this.videos = {};
        
        // Timeline and playback control flags
        this.isLoadingClip = false; // Flag to prevent timeline updates during clip loading
        this.isAutoAdvancing = false; // Flag to prevent multiple rapid auto-advancements
        this.isSeekingTimeline = false; // Flag to prevent timeline updates during manual seeking
        this.isDraggingMarker = false; // Flag to prevent timeline updates during marker dragging
        this.isUpdatingTimeline = false; // Flag to prevent timeline updates during updates
        this.seekTimeout = null; // Debounce timer for seeking

        this.initializeApp();
    }

    async initializeApp() {
        console.log('Initializing Sentry-Six Electron...');
        
        // Set up scan progress listener for optimized folder scanning
        this.setupScanProgressListener();
        
        try {
            // Show loading screen
            this.showLoadingScreen('Initializing application...');
            
            // Load configuration
            await this.loadConfiguration();
            
            // Onboarding: Show welcome modal if first run or no folder selected
            this.checkOnboarding();
            
            // Initialize UI components
            this.initializeUI();
            
            // Set up event listeners
            this.setupEventListeners();

        // Set up sticky header behavior
        this.setupStickyHeaders();

        // Set up export system
        this.setupExportSystem();

        // Set up event markers
        this.setupEventMarkers();

        // Initialize video players
        this.initializeVideoPlayers();

        // Set up camera zoom functionality (after video players are initialized)
        this.setupCameraZoom();

            // Initialize debug manager
            this.initializeDebugManager();

            // Hide loading screen
            this.hideLoadingScreen();
            
            console.log('Sentry-Six Electron initialized successfully');

            // Make app instance globally accessible for debugging
            window.sentrySixApp = this;

        } catch (error) {
            console.error('Failed to initialize application:', error);
            this.showError('Failed to initialize application', error.message);
        }
    }

    async loadConfiguration() {
        try {
            // For now, use default configuration
            this.config = {
                defaultVolume: 0.5,
                playbackSpeed: 1.0,
                autoPlay: false,
                zeroProbeOnLoad: false
            };
            // Load persisted settings
            try {
                const savedZeroProbe = localStorage.getItem('settings.zeroProbeOnLoad');
                if (savedZeroProbe !== null) {
                    this.config.zeroProbeOnLoad = JSON.parse(savedZeroProbe) === true;
                    this.zeroProbeOnLoad = this.config.zeroProbeOnLoad;
                }
            } catch {}
            console.log('Configuration loaded:', this.config);
        } catch (error) {
            console.error('Failed to load configuration:', error);
            this.config = {}; // Use defaults
        }
    }

    initializeUI() {
        // Detect and apply system dark mode preference, and listen for changes
        const applySystemDarkMode = () => {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
            // Update onboarding modal theme immediately
            if (this.checkOnboarding) this.checkOnboarding();
        };
        applySystemDarkMode();
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySystemDarkMode);
        }
        
        // Set up timestamp display
        this.updateTimestampDisplay();
        
        // Set up volume from config
        const volumeSlider = document.getElementById('volume-slider');
        if (volumeSlider && this.config.defaultVolume !== undefined) {
            volumeSlider.value = this.config.defaultVolume;
        }
        
        // Set up playback speed from config
        const speedSelect = document.getElementById('speed-select');
        if (speedSelect && this.config.playbackSpeed !== undefined) {
            speedSelect.value = this.config.playbackSpeed;
        }

        // Settings modal wiring
        const settingsBtn = document.getElementById('settings-btn');
        const settingsModal = document.getElementById('settings-modal');
        const settingsCloseBtn = document.getElementById('settings-close-btn');
        const settingsCloseX = document.getElementById('close-settings-modal');
        const zeroProbeToggle = document.getElementById('zero-probe-toggle');

        if (settingsBtn && settingsModal) {
            settingsBtn.addEventListener('click', () => {
                if (zeroProbeToggle) zeroProbeToggle.checked = !!this.config.zeroProbeOnLoad;
                settingsModal.classList.remove('hidden');
            });
        }
        if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', () => settingsModal?.classList.add('hidden'));
        if (settingsCloseX) settingsCloseX.addEventListener('click', () => settingsModal?.classList.add('hidden'));
        if (zeroProbeToggle) {
            zeroProbeToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                this.config.zeroProbeOnLoad = enabled;
                try { localStorage.setItem('settings.zeroProbeOnLoad', JSON.stringify(enabled)); } catch {}
                this.zeroProbeOnLoad = enabled; // keep flag in sync
            });
        }

        // Enable drag-and-drop for camera grid
        this.setupCameraGridDragAndDrop();
        // Setup reset layout button
        const resetBtn = document.getElementById('reset-camera-layout');
        if (resetBtn) {
            resetBtn.onclick = () => this.resetCameraGridLayout();
        }

        // Add Update button handler
        const updateBtn = document.getElementById('update-btn');
        if (updateBtn) {
            updateBtn.addEventListener('click', async () => {
                this.showStatus('Checking for updates...');
                try {
                    this.showLoadingScreen('Checking for updates...');
                    const result = await window.electronAPI.invoke('app:update-to-commit');
                    this.hideLoadingScreen();
                    
                    if (result && result.success) {
                        if (result.alreadyUpToDate) {
                            // User is already up to date
                            alert(result.message);
                            this.showStatus('Already up to date!');
                        } else {
                            // Update was downloaded and applied
                            alert('Update downloaded and applied!\n\nPlease restart the app to use the latest version.');
                            this.showStatus('Update downloaded! Please restart the app.');
                        }
                    } else {
                        alert('Update failed: ' + (result && result.error ? result.error : 'Unknown error'));
                        this.showStatus('Update failed: ' + (result && result.error ? result.error : 'Unknown error'));
                    }
                } catch (err) {
                    this.hideLoadingScreen();
                    alert('Update failed: ' + err);
                    this.showStatus('Update failed: ' + err);
                }
            });
        }
    }

    resetCameraGridLayout() {
        const grid = document.getElementById('video-grid');
        if (!grid) return;
        const defaultOrder = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        const containers = {};
        Array.from(grid.querySelectorAll('.video-container')).forEach(c => {
            containers[c.dataset.camera] = c;
        });
        defaultOrder.forEach(cam => {
            if (containers[cam]) grid.appendChild(containers[cam]);
        });
    }

    setupCameraGridDragAndDrop() {
        const grid = document.getElementById('video-grid');
        if (!grid) return;
        const containers = Array.from(grid.querySelectorAll('.video-container'));
        containers.forEach(container => {
            container.setAttribute('draggable', 'true');
            container.addEventListener('dragstart', (e) => {
                if (e.ctrlKey) {
                    e.preventDefault(); // Disable drag-and-drop if Ctrl is held
                    return;
                }
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', container.dataset.camera);
                container.classList.add('dragging');
            });
            container.addEventListener('dragend', () => {
                container.classList.remove('dragging');
            });
            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                container.classList.add('drag-over');
            });
            container.addEventListener('dragleave', () => {
                container.classList.remove('drag-over');
            });
            container.addEventListener('drop', (e) => {
                e.preventDefault();
                container.classList.remove('drag-over');
                const draggedCamera = e.dataTransfer.getData('text/plain');
                if (!draggedCamera || draggedCamera === container.dataset.camera) return;
                const allContainers = Array.from(grid.querySelectorAll('.video-container'));
                const draggedElem = grid.querySelector(`.video-container[data-camera="${draggedCamera}"]`);
                const targetElem = container;
                const draggedIdx = allContainers.indexOf(draggedElem);
                const targetIdx = allContainers.indexOf(targetElem);
                if (draggedElem && targetElem && draggedIdx !== -1 && targetIdx !== -1 && draggedElem !== targetElem) {
                    // Swap in array
                    const newOrder = [...allContainers];
                    newOrder[draggedIdx] = targetElem;
                    newOrder[targetIdx] = draggedElem;
                    // Re-append in new order
                    newOrder.forEach(el => grid.appendChild(el));
                }
            });
        });
    }

    setupEventListeners() {
        // Folder selection
        const openFolderBtn = document.getElementById('open-folder-btn');
        if (openFolderBtn) openFolderBtn.addEventListener('click', () => this.selectTeslaFolder());

        // Playback controls
        const playPauseBtn = document.getElementById('play-pause-btn');
        if (playPauseBtn) playPauseBtn.addEventListener('click', () => this.togglePlayPause());

        const stopBtn = document.getElementById('stop-btn');
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopPlayback());

        // Frame-by-frame and skip buttons
        const frameBackBtn = document.getElementById('frame-back-btn');
        if (frameBackBtn) frameBackBtn.addEventListener('click', () => this.frameStep(-1));
        const frameForwardBtn = document.getElementById('frame-forward-btn');
        if (frameForwardBtn) frameForwardBtn.addEventListener('click', () => this.frameStep(1));
        const skipBackBtn = document.getElementById('skip-back-15-btn');
        if (skipBackBtn) skipBackBtn.addEventListener('click', () => this.skipSeconds(-15));
        const skipForwardBtn = document.getElementById('skip-forward-15-btn');
        if (skipForwardBtn) skipForwardBtn.addEventListener('click', () => this.skipSeconds(15));

        // Timeline scrubber with debouncing
        const timelineScrubber = document.getElementById('timeline-scrubber');
        if (timelineScrubber) {
            timelineScrubber.addEventListener('input', (e) => this.debouncedSeek(e.target.value));
            timelineScrubber.addEventListener('mousedown', () => {
                this.isSeekingTimeline = true;
                console.log('🎯 Started seeking');
            });
            timelineScrubber.addEventListener('mouseup', () => {
                setTimeout(() => {
                    this.isSeekingTimeline = false;
                    console.log('🎯 Finished seeking');
                }, 500);
            });
            timelineScrubber.addEventListener('touchstart', () => this.isSeekingTimeline = true);
            timelineScrubber.addEventListener('touchend', () => {
                setTimeout(() => {
                    this.isSeekingTimeline = false;
                }, 500);
            });
        }

        // Speed control
        const speedSelect = document.getElementById('speed-select');
        if (speedSelect) speedSelect.addEventListener('change', (e) => this.setPlaybackSpeed(parseFloat(e.target.value)));

        // Volume control
        const volumeSlider = document.getElementById('volume-slider');
        if (volumeSlider) volumeSlider.addEventListener('input', (e) => this.setVolume(parseFloat(e.target.value)));

        // Settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.openSettings());

        // Camera visibility panel
        const cameraToggleBtn = document.getElementById('camera-toggle-btn');
        if (cameraToggleBtn) cameraToggleBtn.addEventListener('click', () => this.toggleCameraPanel());

        const closeCameraPanel = document.getElementById('close-camera-panel');
        if (closeCameraPanel) closeCameraPanel.addEventListener('click', () => this.hideCameraPanel());

        // Camera visibility toggles
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        cameras.forEach(camera => {
            const toggle = document.getElementById(`toggle-${camera}`);
            if (toggle) toggle.addEventListener('change', (e) => this.toggleCameraVisibility(camera, e.target.checked));
        });

        // Show/Hide all cameras
        const showAllBtn = document.getElementById('show-all-cameras');
        if (showAllBtn) showAllBtn.addEventListener('click', () => this.showAllCameras());

        const hideAllBtn = document.getElementById('hide-all-cameras');
        if (hideAllBtn) hideAllBtn.addEventListener('click', () => this.hideAllCameras());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        // Listen for folder selection from main process
        if (window.electronAPI && window.electronAPI.on) {
            window.electronAPI.on('folder-selected', (folderPath) => {
                this.loadTeslaFolder(folderPath);
            });
        }
    }

    initializeVideoPlayers() {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        
        cameras.forEach(camera => {
            const video = document.getElementById(`video-${camera}`);
            if (video) {
                this.videos[camera] = video;
                
                // Set up video event listeners
                video.addEventListener('loadedmetadata', () => this.onVideoLoaded(camera));
                video.addEventListener('timeupdate', () => this.onVideoTimeUpdate(camera));
                video.addEventListener('ended', () => this.onVideoEnded(camera));
                video.addEventListener('error', (e) => this.onVideoError(camera, e));
                
                // Set initial volume
                video.volume = this.config.defaultVolume || 0.5;
                video.muted = true; // Start muted for auto-play compatibility
            }
        });
    }

    initializeDebugManager() {
        try {
            // Initialize debug manager
            this.debugManager = new DebugManager();
            console.log('Debug manager initialized successfully');
        } catch (error) {
            console.error('Failed to initialize debug manager:', error);
        }
    }

    async selectTeslaFolder(fromOnboarding = false, dontShow = false) {
        try {
            console.log('🔄 Starting Tesla folder selection...');
            this.showLoadingIndicator(true);

            const result = await window.electronAPI.tesla.selectFolder();
            console.log('📁 Folder selection result:', result);

            if (result && result.success && result.videoFiles) {
                this.clipSections = result.videoFiles;
                
                // Initialize duration processing status for all dates
                this.initializeDurationProcessingStatus();
                
                this.renderCollapsibleClipList();

                // Skip loading all events upfront - they'll be loaded on-demand per date
                // This dramatically speeds up initial folder loading!
                console.log('📁 Folder structure loaded - events will load on-demand');

                // Save folder path for onboarding persistence
                localStorage.setItem('teslaFolder', result.path);
                if (dontShow) {
                    localStorage.setItem('onboardingNeverShow', 'true');
                } else {
                    // If user did NOT check 'Don't show again', clear onboarding flags so modal shows next time
                    localStorage.removeItem('onboardingShown');
                    localStorage.removeItem('onboardingNeverShow');
                }
                // Hide onboarding modal only after successful folder selection
                const onboardingModal = document.getElementById('onboarding-modal');
                if (onboardingModal) onboardingModal.classList.add('hidden');

                // Count total clips across all sections
                let totalClips = 0;
                for (const sectionName in this.clipSections) {
                    for (const dateGroup of this.clipSections[sectionName]) {
                        totalClips += dateGroup.totalClips;
                    }
                }

                console.log(`✅ Loaded ${totalClips} clips organized into sections from ${result.path}`);
                this.showStatus(`Found ${totalClips} Tesla video clips`);
                
                // Prefill durations/status from cache (instant green when fully cached)
                console.log('🔄 Starting to prefill durations from cache...');
                
                // TEMPORARY: Skip prefill for large datasets to prevent hanging
                const totalClipsCount = Object.values(this.clipSections).reduce((sum, dateGroups) => 
                    sum + dateGroups.reduce((groupSum, dateGroup) => groupSum + (dateGroup.clips?.length || 0), 0), 0);
                
                if (totalClipsCount > 10000) {
                    console.log(`⚠️ Large dataset detected (${totalClipsCount} clips) - skipping prefill to prevent hanging`);
                } else {
                    await this.prefillDurationsFromCache();
                    console.log('✅ Finished prefilling durations from cache');
                }

                // Start background duration processing unless zero-probe is enabled
                if (!this.zeroProbeOnLoad) {
                    // this.startBackgroundDurationProcessing();
                } else {
                    console.log('Zero-probe mode enabled: not starting background probing');
                }
                
                console.log('🎯 selectTeslaFolder try block completed successfully');
            } else {
                console.log('❌ No folder selected or no videos found');
                this.showStatus('No Tesla videos found in selected folder');
            }

        } catch (error) {
            console.error('❌ Failed to select Tesla folder:', error);
            this.showError('Failed to load Tesla folder', error.message);
        } finally {
            console.log('🏁 FINALLY BLOCK: Hiding loading indicator...');
            this.showLoadingIndicator(false);
            console.log('🏁 FINALLY BLOCK: Loading indicator hidden successfully');
        }
    }

    async loadTeslaFolder(folderPath) {
        try {
            this.showLoadingIndicator(true);
            
            const clipGroups = await window.electronAPI.tesla.getVideoFiles(folderPath);
            
            if (clipGroups && clipGroups.length > 0) {
                this.clipGroups = clipGroups;
                this.renderClipList();
                console.log(`Loaded ${clipGroups.length} clip groups from ${folderPath}`);
            }
            
        } catch (error) {
            console.error('Failed to load Tesla folder:', error);
            this.showError('Failed to load Tesla folder', error.message);
        } finally {
            this.showLoadingIndicator(false);
        }
    }

    // Initialize duration processing status for all dates
    initializeDurationProcessingStatus() {
        this.durationProcessingStatus = {};
        this.durationProcessingQueue = [];
        
        for (const [sectionName, dateGroups] of Object.entries(this.clipSections)) {
            for (let dateIndex = 0; dateIndex < dateGroups.length; dateIndex++) {
                const dateKey = `${sectionName}-${dateIndex}`;
                this.durationProcessingStatus[dateKey] = {
                    status: 'pending', // 'pending', 'processing', 'completed', 'error'
                    progress: 0,
                    totalClips: dateGroups[dateIndex].clips.length,
                    processedClips: 0,
                    error: null
                };
                this.durationProcessingQueue.push({ sectionName, dateIndex });
            }
        }
        
        console.log(`Initialized duration processing for ${this.durationProcessingQueue.length} dates`);
    }

    // Start background duration processing (disabled for on-demand processing)
    async startBackgroundDurationProcessing() {
        console.log('Background duration processing disabled - using on-demand processing instead');
        return; // Exit early to disable background processing
        
        if (this.isProcessingDurations) {
            console.log('Duration processing already in progress');
            return;
        }

        this.isProcessingDurations = true;
        console.log('Starting background duration processing...');

        try {
            // Process dates in the background
            while (this.durationProcessingQueue.length > 0) {
                const { sectionName, dateIndex } = this.durationProcessingQueue.shift();
                
                try {
                    await this.processDateDurations(sectionName, dateIndex);
                } catch (error) {
                    console.error(`Error processing durations for ${sectionName}-${dateIndex}:`, error);
                    // Continue with next date even if one fails
                }
                
                // Small delay to prevent blocking the UI
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error('Background duration processing failed:', error);
        } finally {
            this.isProcessingDurations = false;
            console.log('Background duration processing completed');
        }
    }

    // Process durations for a specific date using batched approach
    async processDateDurations(sectionName, dateIndex) {
        const dateKey = `${sectionName}-${dateIndex}`;
        const dateGroup = this.clipSections[sectionName][dateIndex];
        
        if (!dateGroup || !dateGroup.clips) {
            console.log(`No clips found for date ${dateKey}`);
            return;
        }

        // Respect zero-probe mode and skip probing if disabled globally
        if (this.zeroProbeOnLoad) {
            console.log(`Zero-probe enabled: skipping probing for ${dateKey}`);
            return;
        }

        // Skip probing if cache has already completed this date
        const status = this.durationProcessingStatus[dateKey];
        if (status && status.status === 'completed') {
            console.log(`Skipping probing for ${dateKey}: already completed from cache`);
            return;
        }

        console.log(`Processing durations for ${dateKey}: ${dateGroup.clips.length} clips`);
        
        // Update status to processing
        this.durationProcessingStatus[dateKey].status = 'processing';
        this.currentlyProcessingDate = dateKey;
        this.updateDateStatusIndicator(sectionName, dateIndex);

        try {
            // Sort clips by timestamp
            const sortedClips = [...dateGroup.clips].sort((a, b) => 
                new Date(a.timestamp) - new Date(b.timestamp)
            );

            // Collect all front camera file paths for batch processing
            const filePaths = [];
            for (const clip of sortedClips) {
                const frontCameraFile = clip.files?.front;
                if (frontCameraFile && frontCameraFile.path) {
                    filePaths.push(frontCameraFile.path);
                } else {
                    filePaths.push(null);
                }
            }

            console.log(`📦 Batch processing ${filePaths.filter(p => p).length} files for ${dateKey}`);

            // Process all durations in batch
            const batchResult = await window.electronAPI.batchProcessDurations(filePaths.filter(p => p));
            
            if (!batchResult.success) {
                throw new Error(batchResult.error || 'Batch processing failed');
            }

            const actualDurations = [];
            let totalDurationMs = 0;
            let batchIndex = 0;

            for (let i = 0; i < sortedClips.length; i++) {
                const clip = sortedClips[i];
                
                // Update progress
                this.durationProcessingStatus[dateKey].processedClips = i + 1;
                this.durationProcessingStatus[dateKey].progress = ((i + 1) / sortedClips.length) * 100;
                this.updateDateStatusIndicator(sectionName, dateIndex);

                if (filePaths[i]) {
                    const duration = batchResult.durations[batchIndex] || 0;
                    const durationMs = Math.round(duration * 1000);
                    actualDurations.push(durationMs);
                    totalDurationMs += durationMs;
                    clip.duration = durationMs;
                    batchIndex++;
                    
                    console.log(`✅ Got duration for clip ${i + 1}: ${duration}s (${durationMs}ms)`);
                } else {
                    console.log(`No front camera file found for clip ${i + 1}, using default duration`);
                    actualDurations.push(60000);
                    totalDurationMs += 60000;
                    clip.duration = 60000;
                }
            }

            // Store the results
            dateGroup.actualDurations = actualDurations;
            dateGroup.actualTotalDuration = totalDurationMs;
            dateGroup.sortedClips = sortedClips;

            // Update status to completed
            this.durationProcessingStatus[dateKey].status = 'completed';
            this.durationProcessingStatus[dateKey].progress = 100;
            this.durationProcessingStatus[dateKey].processedClips = sortedClips.length;
            
            console.log(`✅ Completed batch duration processing for ${dateKey}: ${totalDurationMs}ms total duration, ${batchResult.cacheUpdatedFolders} folders updated`);

            if (batchResult.cacheUpdatedFolders > 0) {
                console.log(`🔄 Re-filtering clips for ${dateKey} after corruption detection`);
                try {
                    const refilterResult = await window.electronAPI.tesla.refilterClips({
                        clips: dateGroup.clips
                    });
                    
                    if (refilterResult.success && refilterResult.filteredClips) {
                        // Update the date group with filtered clips
                        dateGroup.clips = refilterResult.filteredClips;
                        dateGroup.totalClips = refilterResult.filteredClips.length;
                        dateGroup.filteredClipCount = refilterResult.filteredClips.length;
                        
                        console.log(`✅ Re-filtered ${dateKey}: ${refilterResult.originalCount} → ${refilterResult.filteredCount} clips`);
                        
                        this.renderCollapsibleClipList();
                    }
                } catch (error) {
                    console.error(`❌ Error re-filtering clips for ${dateKey}:`, error);
                }
            }

        } catch (error) {
            console.error(`❌ Error processing durations for ${dateKey}:`, error);
            
            // Update status to error
            this.durationProcessingStatus[dateKey].status = 'error';
            this.durationProcessingStatus[dateKey].error = error.message;
        }

        this.currentlyProcessingDate = null;
        this.updateDateStatusIndicator(sectionName, dateIndex);
    }

    // Process durations for a specific date asynchronously without blocking UI
    async processDateDurationsAsync(sectionName, dateIndex) {
        try {
            // Process durations using the existing batched approach
            await this.processDateDurations(sectionName, dateIndex);
            
            const currentlySelected = document.querySelector(`[data-section="${sectionName}"][data-date-index="${dateIndex}"].active`);
            if (currentlySelected && this.currentTimeline && this.currentTimeline.sectionName === sectionName) {
                console.log(`Duration processing completed for selected date ${sectionName}-${dateIndex}, refreshing timeline`);
                
                // Get the updated date group with new duration data
                const dateGroup = this.clipSections[sectionName][dateIndex];
                
                await this.loadDailyTimeline(dateGroup, sectionName);
                
                console.log(`Timeline refreshed with accurate durations for ${sectionName}-${dateIndex}`);
            }
        } catch (error) {
            console.error(`Error in async duration processing for ${sectionName}-${dateIndex}:`, error);
        }
    }

    // Update the status indicator for a specific date
    updateDateStatusIndicator(sectionName, dateIndex) {
        const dateKey = `${sectionName}-${dateIndex}`;
        const status = this.durationProcessingStatus[dateKey];
        
        if (!status) return;

        const dateItem = document.querySelector(`[data-section="${sectionName}"][data-date-index="${dateIndex}"]`);
        if (!dateItem) return;

        // Remove existing status indicator
        const existingIndicator = dateItem.querySelector('.duration-status-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        // Create new status indicator
        const indicator = document.createElement('div');
        indicator.className = 'duration-status-indicator';
        
        switch (status.status) {
            case 'pending':
                indicator.innerHTML = '<div class="status-dot status-red"></div>';
                break;
            case 'processing':
                indicator.innerHTML = '<div class="status-dot status-amber pulse"></div>';
                break;
            case 'completed':
                indicator.innerHTML = '<div class="status-dot status-green"></div>';
                break;
            case 'error':
                indicator.innerHTML = '<div class="status-dot status-red blink"></div>';
                break;
        }

        // Add tooltip with status info
        let tooltipText = '';
        switch (status.status) {
            case 'pending':
                tooltipText = 'Duration analysis pending';
                break;
            case 'processing':
                tooltipText = `Processing durations: ${status.processedClips}/${status.totalClips} clips`;
                break;
            case 'completed':
                tooltipText = `Duration analysis complete: ${Math.round(status.totalClips * 45 / 60)}m estimated`;
                break;
            case 'error':
                tooltipText = `Error: ${status.error}`;
                break;
        }
        indicator.title = tooltipText;

        // Insert indicator at the beginning of the date item
        dateItem.insertBefore(indicator, dateItem.firstChild);

        // Also update the duration text to reflect estimate vs real
        try {
            const dateGroup = this.clipSections?.[sectionName]?.[dateIndex];
            const durationEl = dateItem.querySelector('.date-duration');
            if (dateGroup && durationEl) {
                const isCompleted = status.status === 'completed' && (
                    !!dateGroup.actualTotalDuration || (Array.isArray(dateGroup.actualDurations) && dateGroup.actualDurations.length > 0)
                );

                let totalDurationMs = 0;
                if (isCompleted) {
                    if (dateGroup.actualTotalDuration) {
                        totalDurationMs = dateGroup.actualTotalDuration;
                    } else if (Array.isArray(dateGroup.actualDurations)) {
                        totalDurationMs = dateGroup.actualDurations.reduce((a, b) => a + (b || 60000), 0);
                    }
                } else {
                    const clipCount = dateGroup.clips?.length || 0;
                    const estimatedSecondsPerClip = clipCount === 1 ? 35 : 45;
                    totalDurationMs = clipCount * estimatedSecondsPerClip * 1000;
                }

                // Format duration
                const totalMinutes = Math.floor(totalDurationMs / 60000);
                const totalHours = Math.floor(totalMinutes / 60);
                const remainingMinutes = totalMinutes % 60;
                let durationText;
                if (totalHours > 0) {
                    durationText = `${totalHours}h ${remainingMinutes}m`;
                } else if (totalMinutes > 0) {
                    durationText = `${totalMinutes}m`;
                } else {
                    const totalSeconds = Math.floor(totalDurationMs / 1000);
                    durationText = `${totalSeconds}s`;
                }

                const tildePrefix = isCompleted ? '' : '<span class="duration-tilde">~</span>';
                durationEl.innerHTML = `${tildePrefix}${durationText}`;
            }
        } catch (e) {
            console.warn('Failed to update duration text for', sectionName, dateIndex, e);
        }
    }

    // Add status indicators to all dates after rendering
    addStatusIndicatorsToAllDates() {
        for (const [sectionName, dateGroups] of Object.entries(this.clipSections)) {
            for (let dateIndex = 0; dateIndex < dateGroups.length; dateIndex++) {
                this.updateDateStatusIndicator(sectionName, dateIndex);
            }
        }
    }

    // Prefill durations and statuses using cache without probing
    async prefillDurationsFromCache() {
        if (!window.electronAPI || !window.electronAPI.getCachedDurations) return;

        console.log('🔄 prefillDurationsFromCache: Starting to process sections...');
        let totalDateGroups = 0;
        let processedDateGroups = 0;

        // Count total date groups first
        for (const [sectionName, dateGroups] of Object.entries(this.clipSections)) {
            totalDateGroups += dateGroups.length;
        }
        console.log(`🔄 prefillDurationsFromCache: Found ${totalDateGroups} date groups across ${Object.keys(this.clipSections).length} sections`);

        for (const [sectionName, dateGroups] of Object.entries(this.clipSections)) {
            console.log(`🔄 Processing section: ${sectionName} (${dateGroups.length} date groups)`);
            
            for (let dateIndex = 0; dateIndex < dateGroups.length; dateIndex++) {
                const dateGroup = dateGroups[dateIndex];
                if (!dateGroup || !dateGroup.clips) continue;

                processedDateGroups++;
                console.log(`🔄 Processing date group ${processedDateGroups}/${totalDateGroups} in ${sectionName}: ${dateGroup.clips.length} clips`);

                // Build file list using front camera to derive durations
                const files = [];
                const sortedClips = [...dateGroup.clips].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                for (const clip of sortedClips) {
                    const front = clip.files && clip.files.front;
                    if (front && front.path) files.push(front.path);
                }

                if (files.length === 0) continue;

                try {
                    console.log(`🔄 Calling getCachedDurations for ${files.length} files...`);
                    const { durations, allCached } = await window.electronAPI.getCachedDurations(files, true);
                    console.log(`✅ getCachedDurations completed for ${files.length} files`);
                    // If all cached, set actual durations and mark completed immediately
                    if (durations && durations.length === files.length && durations.every(d => typeof d === 'number' && d > 0)) {
                        const durationsMs = durations.map(s => Math.round(s * 1000));
                        dateGroup.actualDurations = durationsMs;
                        dateGroup.sortedClips = sortedClips;
                        dateGroup.actualTotalDuration = durationsMs.reduce((a, b) => a + b, 0);
                        // Critically, stamp per-clip duration so timeline math uses real values
                        for (let i = 0; i < sortedClips.length; i++) {
                            if (sortedClips[i]) sortedClips[i].duration = durationsMs[i];
                        }

                        const dateKey = `${sectionName}-${dateIndex}`;
                        if (!this.durationProcessingStatus[dateKey]) this.durationProcessingStatus[dateKey] = {};
                        this.durationProcessingStatus[dateKey].status = 'completed';
                        this.durationProcessingStatus[dateKey].progress = 100;
                        this.durationProcessingStatus[dateKey].totalClips = sortedClips.length;
                        this.durationProcessingStatus[dateKey].processedClips = sortedClips.length;
                        this.updateDateStatusIndicator(sectionName, dateIndex);
                    } else {
                        // Not fully cached: mark pending; in zero-probe mode we don't probe, so stay red
                        const dateKey = `${sectionName}-${dateIndex}`;
                        if (!this.durationProcessingStatus[dateKey]) this.durationProcessingStatus[dateKey] = {};
                        this.durationProcessingStatus[dateKey].status = 'pending';
                        this.durationProcessingStatus[dateKey].totalClips = sortedClips.length;
                        this.durationProcessingStatus[dateKey].processedClips = 0;
                        this.durationProcessingStatus[dateKey].progress = 0;
                        this.updateDateStatusIndicator(sectionName, dateIndex);
                    }
                } catch (error) {
                    console.warn(`⚠️ Error processing date group ${processedDateGroups}/${totalDateGroups}:`, error);
                    // Ignore; background processing will handle
                }
            }
        }
        
        console.log('✅ prefillDurationsFromCache: Completed processing all date groups');
    }

    // Wait for duration processing to complete for a specific date
    async waitForDurationProcessing(sectionName, dateIndex) {
        const dateKey = `${sectionName}-${dateIndex}`;
        const maxWaitTime = 30000; // 30 seconds timeout
        const checkInterval = 100; // Check every 100ms
        let elapsedTime = 0;

        // If zero-probe is enabled or already completed from cache, don't wait
        if (this.zeroProbeOnLoad) {
            console.log(`Zero-probe enabled: not waiting for processing for ${dateKey}`);
            return;
        }
        const statusNow = this.durationProcessingStatus[dateKey];
        if (statusNow && statusNow.status === 'completed') {
            return;
        }

        while (elapsedTime < maxWaitTime) {
            const status = this.durationProcessingStatus[dateKey];
            
            if (status && status.status === 'completed') {
                console.log(`Duration processing completed for ${dateKey}`);
                return;
            }
            
            if (status && status.status === 'error') {
                console.log(`Duration processing failed for ${dateKey}: ${status.error}`);
                throw new Error(`Duration processing failed: ${status.error}`);
            }

            // Update loading progress if processing
            if (status && status.status === 'processing') {
                const progress = status.progress || 0;
                this.updateDurationLoadingProgress(status.processedClips, status.totalClips);
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
            elapsedTime += checkInterval;
        }

        throw new Error('Duration processing timeout');
    }

    // Check if duration processing is complete for a specific date
    isDurationProcessingComplete(sectionName, dateIndex) {
        const dateKey = `${sectionName}-${dateIndex}`;
        const status = this.durationProcessingStatus[dateKey];
        return status && status.status === 'completed';
    }

    // Get duration processing status for a specific date
    getDurationProcessingStatus(sectionName, dateIndex) {
        const dateKey = `${sectionName}-${dateIndex}`;
        return this.durationProcessingStatus[dateKey] || null;
    }

    renderClipList() {
        const clipList = document.getElementById('clip-list');
        
        if (this.clipGroups.length === 0) {
            clipList.innerHTML = `
                <div class="no-clips-message">
                    <p>No Tesla clips found</p>
                    <p>Make sure you selected a valid Tesla dashcam folder</p>
                </div>
            `;
            return;
        }

        const clipItems = this.clipGroups.map((clipGroup, index) => {
            const timestamp = new Date(clipGroup.timestamp);
            const timeString = timestamp.toLocaleString();
            const availableCameras = Object.keys(clipGroup.files);
            
            return `
                <div class="clip-item" data-index="${index}">
                    <div class="clip-time">${timeString}</div>
                    <div class="clip-type">${clipGroup.type}</div>
                    <div class="clip-cameras">
                        ${availableCameras.map(camera => 
                            `<span class="camera-badge available">${this.getCameraDisplayName(camera)}</span>`
                        ).join('')}
                    </div>
                </div>
            `;
        }).join('');

        clipList.innerHTML = clipItems;

        // Add click listeners to clip items
        clipList.querySelectorAll('.clip-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.selectClipGroup(index);
            });
        });
    }

    renderCollapsibleClipList() {
        const clipList = document.getElementById('clip-list');

        if (!this.clipSections || Object.keys(this.clipSections).length === 0) {
            clipList.innerHTML = `
                <div class="no-clips-message">
                    <p>No Tesla clips found</p>
                    <p>Make sure you selected the correct Tesla dashcam folder</p>
                </div>
            `;
            return;
        }

        // Preserve current section states before re-rendering
        const currentSectionStates = {};
        document.querySelectorAll('.section-header').forEach(header => {
            const sectionName = header.dataset.section;
            const content = document.querySelector(`[data-section-content="${sectionName}"]`);
            currentSectionStates[sectionName] = !content.classList.contains('collapsed');
        });

        // Preserve currently selected date
        const currentlySelectedDate = document.querySelector('.date-item.active');
        let selectedSectionName = null;
        let selectedDateIndex = null;
        if (currentlySelectedDate) {
            selectedSectionName = currentlySelectedDate.dataset.section;
            selectedDateIndex = parseInt(currentlySelectedDate.dataset.dateIndex);
        }

        let sectionsHtml = '';

        for (const [sectionName, dateGroups] of Object.entries(this.clipSections)) {
            if (dateGroups.length === 0) continue;

            const totalClips = dateGroups.reduce((sum, group) => sum + group.totalClips, 0);
            
            // Use preserved state or default to collapsed for new sections
            const isExpanded = currentSectionStates[sectionName] || false;
            const headerClass = isExpanded ? '' : 'collapsed';
            const contentClass = isExpanded ? 'expanded' : 'collapsed';

            sectionsHtml += `
                <div class="clip-section">
                    <div class="section-header ${headerClass}" data-section="${sectionName}">
                        <span class="section-toggle">▼</span>
                        <span class="section-title">${sectionName}</span>
                        <span class="section-count">${totalClips}</span>
                    </div>
                    <div class="section-content ${contentClass}" data-section-content="${sectionName}">
                        ${this.renderDateGroups(dateGroups, sectionName, selectedSectionName, selectedDateIndex)}
                    </div>
                </div>
            `;
        }

        clipList.innerHTML = sectionsHtml;
        this.setupCollapsibleHandlers();
        
        // Add status indicators for all dates
        this.addStatusIndicatorsToAllDates();
        
        // Scroll selected date into view if it exists
        if (selectedSectionName && selectedDateIndex !== null) {
            const selectedItem = document.querySelector(`[data-section="${selectedSectionName}"][data-date-index="${selectedDateIndex}"].active`);
            if (selectedItem) {
                selectedItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    renderDateGroups(dateGroups, sectionName, selectedSectionName = null, selectedDateIndex = null) {
        return dateGroups.map((dateGroup, dateIndex) => {
            const dateKey = `${sectionName}-${dateIndex}`;
            const statusObj = this.durationProcessingStatus?.[dateKey];
            const isCompleted = !!(statusObj && statusObj.status === 'completed' && (
                dateGroup.actualTotalDuration || (Array.isArray(dateGroup.actualDurations) && dateGroup.actualDurations.length > 0)
            ));

            // Choose duration: real (from cache/probe) if completed, else estimate
            let totalDurationMs = 0;
            if (isCompleted) {
                if (dateGroup.actualTotalDuration) {
                    totalDurationMs = dateGroup.actualTotalDuration;
                } else if (Array.isArray(dateGroup.actualDurations)) {
                    totalDurationMs = dateGroup.actualDurations.reduce((a, b) => a + (b || 60000), 0);
                }
            } else {
                const clipCount = dateGroup.clips.length;
                const estimatedSecondsPerClip = clipCount === 1 ? 35 : 45;
                totalDurationMs = clipCount * estimatedSecondsPerClip * 1000;
            }

            const totalMinutes = Math.floor(totalDurationMs / 60000);
            const totalHours = Math.floor(totalMinutes / 60);
            const remainingMinutes = totalMinutes % 60;

            let durationText = '';
            if (totalHours > 0) {
                durationText = `${totalHours}h ${remainingMinutes}m`;
            } else if (totalMinutes > 0) {
                durationText = `${totalMinutes}m`;
            } else {
                const totalSeconds = Math.floor(totalDurationMs / 1000);
                durationText = `${totalSeconds}s`;
            }

            const tildePrefix = isCompleted ? '' : '<span class="duration-tilde">~</span>';

            // Check if this date should be marked as active
            const isActive = selectedSectionName === sectionName && selectedDateIndex === dateIndex;
            const activeClass = isActive ? 'active' : '';

            return `
                <div class="date-item ${activeClass}" data-section="${sectionName}" data-date-index="${dateIndex}">
                    <div class="date-title">${dateGroup.displayDate}</div>
                    <div class="date-info">
                        <span class="date-duration">${tildePrefix}${durationText}</span>
                        <span class="date-count">${dateGroup.totalClips} clips</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    setupCollapsibleHandlers() {
        // Section headers
        document.querySelectorAll('.section-header').forEach(header => {
            header.addEventListener('click', () => {
                const sectionName = header.dataset.section;
                const content = document.querySelector(`[data-section-content="${sectionName}"]`);
                const isCollapsed = content.classList.contains('collapsed');

                if (isCollapsed) {
                    content.classList.remove('collapsed');
                    content.classList.add('expanded');
                    header.classList.remove('collapsed');
                } else {
                    content.classList.remove('expanded');
                    content.classList.add('collapsed');
                    header.classList.add('collapsed');
                }
            });
        });

        // Date items (direct selection, no collapsing)
        document.querySelectorAll('.date-item').forEach(item => {
            item.addEventListener('click', async () => {
                const sectionName = item.dataset.section;
                const dateIndex = parseInt(item.dataset.dateIndex);

                await this.selectDateTimeline(sectionName, dateIndex);
            });
        });
    }

    async selectDateTimeline(sectionName, dateIndex) {
        const dateGroup = this.clipSections[sectionName][dateIndex];

        // Remove previous selection
        document.querySelectorAll('.date-item.active').forEach(item => {
            item.classList.remove('active');
        });

        // Add selection to current item
        const selectedItem = document.querySelector(`[data-section="${sectionName}"][data-date-index="${dateIndex}"]`);
        if (selectedItem) {
            selectedItem.classList.add('active');
        }

        // Always load timeline immediately (non-blocking)
        console.log('Loading timeline immediately with available data');
        await this.loadDailyTimeline(dateGroup, sectionName);
        
        // Load events on-demand for SavedClips and SentryClips only (RecentClips have no events)
        if (sectionName === 'User Saved' || sectionName === 'Sentry Detection') {
            await this.loadEventMarkersForDate(dateGroup.date, sectionName);
        } else {
            console.log(`📭 Skipping event loading for ${sectionName} (no events expected)`);
        }
        
        // Check if duration processing is needed for this date
        const dateKey = `${sectionName}-${dateIndex}`;
        const status = this.durationProcessingStatus[dateKey];
        
        if (!status || status.status !== 'completed') {
            // Start non-blocking duration processing for this date only
            console.log(`Starting non-blocking duration processing for ${dateKey}`);
            this.processDateDurationsAsync(sectionName, dateIndex);
        }
        
        console.log('Selected daily timeline:', sectionName, 'date:', dateGroup.displayDate, 'clips:', dateGroup.clips.length);
    }

    async loadDailyTimeline(dateGroup, sectionName) {
        // Create a continuous timeline data structure with accurate timestamp analysis
        this.currentTimeline = {
            clips: dateGroup.clips,
            currentClipIndex: 0,
            totalDuration: 0, // Will be calculated from actual timestamps
            displayDuration: 0, // Will be calculated from actual timestamps
            startTime: dateGroup.clips[0]?.timestamp || new Date(),
            isPlaying: false,
            currentPosition: 0, // Global position in milliseconds across all clips
            date: dateGroup.displayDate,
            sectionName: sectionName, // Store the current section name for event filtering
            actualDurations: [], // Store actual clip durations as they load
            loadedClipCount: 0, // Track how many clips have loaded
            clipTimestamps: [], // Store actual start timestamps for each clip
            timelineGaps: [], // Store detected gaps between clips
            accurateTimeline: true, // Flag to indicate we're using accurate timeline
            eventMarkersRendered: false // Flag to track if event markers have been rendered
        };

        // Use pre-processed duration data if available
        if (dateGroup.actualDurations && dateGroup.sortedClips) {
            console.log('Using pre-processed duration data');
            this.currentTimeline.actualDurations = dateGroup.actualDurations;
            this.currentTimeline.sortedClips = dateGroup.sortedClips;
            // Propagate cached durations onto the base clips so subsequent analysis uses them
            try {
                const byKey = new Map();
                for (let i = 0; i < dateGroup.sortedClips.length; i++) {
                    const c = dateGroup.sortedClips[i];
                    const key = c?.files?.front?.path || c?.filename || `${c.timestamp}`;
                    if (key) byKey.set(key, dateGroup.actualDurations[i]);
                }
                for (const clip of this.currentTimeline.clips) {
                    const key = clip?.files?.front?.path || clip?.filename || `${clip.timestamp}`;
                    const d = key ? byKey.get(key) : undefined;
                    if (typeof d === 'number' && d > 0) {
                        clip.duration = d;
                    }
                }
            } catch (e) {
                console.warn('Failed to propagate cached durations to clips:', e);
            }
            
            // Analyze clip timestamps and calculate accurate timeline
            this.analyzeClipTimestamps();
            
            // Calculate timeline duration with pre-processed data
            this.calculateAccurateTimelineDuration();
        } else {
            console.log('Pre-processed duration data not available, using default durations for immediate loading');
            this.analyzeClipTimestamps();
            this.setDefaultClipDurations();
        }

        // Notify debug manager of timeline load
        if (this.debugManager) {
            document.dispatchEvent(new CustomEvent('timelineLoaded', {
                detail: { timeline: this.currentTimeline }
            }));
        }

        // Load the first clip
        this.loadTimelineClip(0);

        // Update timeline UI with gap indicators
        this.updateTimelineDisplay();
        this.renderTimelineGaps();

        // Render event markers on the timeline (allow initial render)
        this.renderEventMarkers();

        // Set flag after initial render to prevent future re-renders during updates
        setTimeout(() => {
            this.isUpdatingTimeline = true;
        }, 100);
    }

    analyzeClipTimestamps() {
        if (!this.currentTimeline || !this.currentTimeline.clips.length) return;

        const clips = this.currentTimeline.clips;
        const timestamps = [];
        const gaps = [];

        // Sort clips by timestamp to ensure chronological order
        const sortedClips = [...clips].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        console.log(`🔍 Analyzing ${sortedClips.length} clips for accurate timeline`);

        for (let i = 0; i < sortedClips.length; i++) {
            const clip = sortedClips[i];
            const clipTimestamp = new Date(clip.timestamp);
            timestamps.push(clipTimestamp);

            console.log(`📹 Clip ${i + 1}: ${clipTimestamp.toLocaleTimeString()} - ${clip.filename}`);

            // Check for gaps between clips
            if (i > 0) {
                const prevClip = sortedClips[i - 1];
                const prevTimestamp = new Date(prevClip.timestamp);
                
                // Calculate expected end time of previous clip (assuming 60s max duration)
                const expectedPrevEnd = new Date(prevTimestamp.getTime() + 60000);
                const actualGap = clipTimestamp.getTime() - expectedPrevEnd.getTime();
                
                if (actualGap > 5000) { // Gap larger than 5 seconds
                    gaps.push({
                        startTime: expectedPrevEnd,
                        endTime: clipTimestamp,
                        duration: actualGap / 1000, // Convert to seconds
                        beforeClipIndex: i - 1,
                        afterClipIndex: i,
                        description: `Gap of ${Math.round(actualGap / 1000)}s between clips`
                    });
                    
                    console.log(`⚠️ Gap detected: ${Math.round(actualGap / 1000)}s between clips ${i} and ${i + 1}`);
                }
            }
        }

        this.currentTimeline.clipTimestamps = timestamps;
        this.currentTimeline.timelineGaps = gaps;
        this.currentTimeline.sortedClips = sortedClips;

        console.log(`📊 Timeline analysis complete: ${gaps.length} gaps detected`);
    }

    async populateAllDurations() {
        console.log('🔍 populateAllDurations: Starting...');
        console.log('🔍 populateAllDurations: window.electronAPI available?', !!window.electronAPI);
        console.log('🔍 populateAllDurations: window.electronAPI.getVideoDuration available?', !!(window.electronAPI && window.electronAPI.getVideoDuration));
        
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) {
            console.log('❌ No timeline or sorted clips available for duration population');
            return;
        }

        const clips = this.currentTimeline.sortedClips;
        console.log(`🔍 Populating durations for ${clips.length} clips...`);

        // Initialize actualDurations array if not already done
        if (!this.currentTimeline.actualDurations) {
            this.currentTimeline.actualDurations = [];
        }

        // Process each clip to get its actual duration
        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            console.log(`🔍 Processing clip ${i + 1}/${clips.length}: ${clip.filename}`);

            // Update loading progress
            this.updateDurationLoadingProgress(i + 1, clips.length);

            // Get the front camera file for duration measurement
            const frontCameraFile = clip.files?.front;
            if (!frontCameraFile) {
                console.log(`⚠️ No front camera file found for clip ${i + 1}, using default duration`);
                this.currentTimeline.actualDurations[i] = 60000; // Default 60 seconds
                continue;
            }

            try {
                console.log(`🔍 Requesting duration for: ${frontCameraFile.path}`);
                // Request duration from main process
                const duration = await window.electronAPI.getVideoDuration(frontCameraFile.path);
                
                if (duration && duration > 0) {
                    const durationMs = Math.round(duration * 1000); // Convert to milliseconds
                    this.currentTimeline.actualDurations[i] = durationMs;
                    
                    // Also update the clip's duration property for consistency
                    clip.duration = durationMs;
                    
                    console.log(`✅ Got duration for clip ${i + 1}: ${duration}s (${durationMs}ms) for ${frontCameraFile.path}`);
                } else {
                    console.log(`❌ Invalid duration received for clip ${i + 1}: ${duration}, using default`);
                    this.currentTimeline.actualDurations[i] = 60000; // Default 60 seconds
                    clip.duration = 60000;
                }
            } catch (error) {
                console.error(`❌ Error getting duration for clip ${i + 1} (${frontCameraFile.path}):`, error);
                console.log(`❌ Using default duration for clip ${i + 1}`);
                this.currentTimeline.actualDurations[i] = 60000; // Default 60 seconds
                clip.duration = 60000;
            }
        }

        console.log(`📊 Duration population complete: ${this.currentTimeline.actualDurations.length} durations populated`);
        console.log(`📊 Actual durations array:`, this.currentTimeline.actualDurations);

        // Recalculate timeline duration with accurate durations
        this.calculateAccurateTimelineDuration();
    }

    calculateAccurateTimelineDuration() {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return;

        const clips = this.currentTimeline.sortedClips;
        if (clips.length === 0) return;

        // Calculate continuous timeline duration (excluding gaps)
        let continuousDuration = 0;
        let totalGapDuration = 0;
        let knownClips = 0;

        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            // Use actual duration from the clip group if available
            const actualDuration = clip.duration || 60000; // 60 seconds default
            continuousDuration += actualDuration;
            knownClips++;
        }

        // Calculate total timeline duration (including gaps)
        const firstClipStart = new Date(clips[0].timestamp);
        const lastClipStart = new Date(clips[clips.length - 1].timestamp);
        const lastClipDuration = clips[clips.length - 1].duration || 60000;
        const lastClipEnd = new Date(lastClipStart.getTime() + lastClipDuration);
        const totalTimelineDuration = lastClipEnd.getTime() - firstClipStart.getTime();
        
        // Calculate total gap duration
        totalGapDuration = totalTimelineDuration - continuousDuration;
        
        this.currentTimeline.totalDuration = continuousDuration; // Continuous playable duration
        this.currentTimeline.displayDuration = continuousDuration; // Display continuous duration
        this.currentTimeline.totalTimelineDuration = totalTimelineDuration; // Total timeline including gaps
        this.currentTimeline.totalGapDuration = totalGapDuration; // Total gap duration
        this.currentTimeline.startTime = firstClipStart;
        this.currentTimeline.endTime = lastClipEnd;

        console.log(`⏱️ Continuous timeline duration: ${Math.round(continuousDuration / 1000)}s (${knownClips}/${clips.length} clips) | Total timeline: ${Math.round(totalTimelineDuration / 1000)}s | Gaps: ${Math.round(totalGapDuration / 1000)}s`);
    }

    setDefaultClipDurations() {
        if (!this.currentTimeline || !this.currentTimeline.clips) return;

        const clips = this.currentTimeline.clips;
        console.log(`Setting default durations for ${clips.length} clips`);

        // Initialize actualDurations array with defaults
        this.currentTimeline.actualDurations = [];
        let totalDurationMs = 0;

        for (let i = 0; i < clips.length; i++) {
            const defaultDuration = 60000; // 60 seconds default
            this.currentTimeline.actualDurations[i] = defaultDuration;
            totalDurationMs += defaultDuration;
            
            // Also set duration on the clip object for consistency
            clips[i].duration = defaultDuration;
        }

        // Set timeline durations
        this.currentTimeline.totalDuration = totalDurationMs;
        this.currentTimeline.displayDuration = totalDurationMs;

        console.log(`Set default timeline duration: ${Math.round(totalDurationMs / 1000)}s for ${clips.length} clips`);
    }

    showDurationLoadingIndicator(selectedItem, totalClips) {
        // Create loading indicator if it doesn't exist
        if (!this.durationLoadingIndicator) {
            this.durationLoadingIndicator = document.createElement('div');
            this.durationLoadingIndicator.id = 'duration-loading-indicator';
            this.durationLoadingIndicator.innerHTML = `
                <div class="loading-content">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">
                        <div class="loading-title">Analyzing Video Durations</div>
                        <div class="loading-subtitle">Please wait while we probe ${totalClips} video files...</div>
                        <div class="loading-progress">
                            <div class="progress-bar">
                                <div class="progress-fill"></div>
                            </div>
                            <div class="progress-text">0 / ${totalClips}</div>
                        </div>
                    </div>
                </div>
            `;
            this.durationLoadingIndicator.className = 'duration-loading-overlay';
            document.body.appendChild(this.durationLoadingIndicator);
        } else {
            // Update existing indicator
            const progressText = this.durationLoadingIndicator.querySelector('.loading-subtitle');
            const progressBar = this.durationLoadingIndicator.querySelector('.progress-fill');
            const progressCount = this.durationLoadingIndicator.querySelector('.progress-text');
            
            if (progressText) progressText.textContent = `Please wait while we probe ${totalClips} video files...`;
            if (progressBar) progressBar.style.width = '0%';
            if (progressCount) progressCount.textContent = `0 / ${totalClips}`;
        }

        // Show the indicator
        this.durationLoadingIndicator.style.display = 'flex';
    }

    updateDurationLoadingProgress(current, total) {
        if (this.durationLoadingIndicator) {
            const progressBar = this.durationLoadingIndicator.querySelector('.progress-fill');
            const progressCount = this.durationLoadingIndicator.querySelector('.progress-text');
            
            if (progressBar) {
                const percentage = (current / total) * 100;
                progressBar.style.width = `${percentage}%`;
            }
            if (progressCount) {
                progressCount.textContent = `${current} / ${total}`;
            }
        }
    }

    hideDurationLoadingIndicator() {
        if (this.durationLoadingIndicator) {
            this.durationLoadingIndicator.style.display = 'none';
        }
    }

    calculateAccurateClipPosition(clipIndex) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return 0;

        const clips = this.currentTimeline.sortedClips;
        if (clipIndex >= clips.length) return 0;

        const targetClip = clips[clipIndex];
        const targetTimestamp = new Date(targetClip.timestamp);
        const startTimestamp = new Date(this.currentTimeline.startTime);

        return targetTimestamp.getTime() - startTimestamp.getTime();
    }

    // Convert continuous timeline position to actual timeline position (including gaps)
    continuousToActualPosition(continuousPositionMs) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return continuousPositionMs;

        const clips = this.currentTimeline.sortedClips;
        let actualPosition = 0;
        let continuousPosition = 0;

        // Handle edge case: if continuous position is at the very end, return the actual timeline end
        if (continuousPositionMs >= this.currentTimeline.displayDuration) {
            const lastClip = clips[clips.length - 1];
            const lastClipStart = new Date(lastClip.timestamp);
            const startTimestamp = new Date(this.currentTimeline.startTime);
            const lastClipDuration = lastClip.duration || 60000;
            return (lastClipStart.getTime() - startTimestamp.getTime()) + lastClipDuration;
        }

        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            const clipDuration = clip.duration || 60000;
            
            // If this clip contains the continuous position
            if (continuousPosition + clipDuration > continuousPositionMs) {
                const timeInClip = continuousPositionMs - continuousPosition;
                const clipStart = new Date(clip.timestamp);
                const startTimestamp = new Date(this.currentTimeline.startTime);
                actualPosition = clipStart.getTime() - startTimestamp.getTime() + timeInClip;
                break;
            }
            
            continuousPosition += clipDuration;
        }

        return actualPosition;
    }

    // Convert actual timeline position (including gaps) to continuous timeline position
    actualToContinuousPosition(actualPositionMs) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return actualPositionMs;

        const clips = this.currentTimeline.sortedClips;
        let continuousPosition = 0;
        let actualPosition = 0;

        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            const clipDuration = clip.duration || 60000;
            const clipStart = new Date(clip.timestamp);
            const startTimestamp = new Date(this.currentTimeline.startTime);
            const clipActualStart = clipStart.getTime() - startTimestamp.getTime();
            const clipActualEnd = clipActualStart + clipDuration;

            // If this clip contains the actual position
            if (actualPositionMs >= clipActualStart && actualPositionMs < clipActualEnd) {
                const timeInClip = actualPositionMs - clipActualStart;
                continuousPosition += timeInClip;
                break;
            } else if (actualPositionMs >= clipActualEnd) {
                // This clip is before the target position, add its duration to continuous position
                continuousPosition += clipDuration;
            }
        }

        return continuousPosition;
    }

    calculateAccurateGlobalPosition(clipIndex, timeInClipMs) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return 0;

        const clips = this.currentTimeline.sortedClips;
        if (clipIndex >= clips.length) return 0;

        // Get the clip's start position in the timeline
        const clipStartPosition = this.calculateAccurateClipPosition(clipIndex);
        
        // Add the time within the clip
        return clipStartPosition + timeInClipMs;
    }

    findClipIndexByGlobalPosition(globalPositionMs) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return 0;

        const clips = this.currentTimeline.sortedClips;
        const startTimestamp = new Date(this.currentTimeline.startTime);
        const targetTimestamp = new Date(startTimestamp.getTime() + globalPositionMs);

        // Find which clip contains this timestamp
        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            const clipStart = new Date(clip.timestamp);
            // Use actual duration from the clip group
            const clipDuration = clip.duration || 60000;
            const clipEnd = new Date(clipStart.getTime() + clipDuration);

            if (targetTimestamp >= clipStart && targetTimestamp < clipEnd) {
                return i;
            }
        }

        // If not found in any clip, find the nearest available clip
        let nearestClipIndex = 0;
        let smallestTimeDiff = Math.abs(targetTimestamp.getTime() - new Date(clips[0].timestamp).getTime());

        for (let i = 1; i < clips.length; i++) {
            const clip = clips[i];
            const clipStart = new Date(clip.timestamp);
            const timeDiff = Math.abs(targetTimestamp.getTime() - clipStart.getTime());

            if (timeDiff < smallestTimeDiff) {
                smallestTimeDiff = timeDiff;
                nearestClipIndex = i;
            }
        }

        console.log(`⚠️ Target timestamp ${targetTimestamp.toLocaleTimeString()} not found in any clip, using nearest clip ${nearestClipIndex + 1} at ${new Date(clips[nearestClipIndex].timestamp).toLocaleTimeString()}`);
        return nearestClipIndex;
    }

    calculateTimeInClip(globalPositionMs, clipIndex) {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return 0;

        const clips = this.currentTimeline.sortedClips;
        if (clipIndex >= clips.length) return 0;

        const clipStartPosition = this.calculateAccurateClipPosition(clipIndex);
        const timeInClip = globalPositionMs - clipStartPosition;

        return Math.max(0, timeInClip);
    }

    seekToAccurateGlobalPosition(globalPositionMs) {
        if (!this.currentTimeline) return;

        // Set flag to prevent event marker re-rendering during seeking
        this.isUpdatingTimeline = true;

        // Find which clip contains this position
        const targetClipIndex = this.findClipIndexByGlobalPosition(globalPositionMs);
        const timeInClipMs = this.calculateTimeInClip(globalPositionMs, targetClipIndex);

        console.log(`🎯 Seeking to accurate position: ${Math.round(globalPositionMs/1000)}s -> clip ${targetClipIndex + 1}, time ${Math.round(timeInClipMs/1000)}s`);

        // Load the target clip if different from current
        if (targetClipIndex !== this.currentTimeline.currentClipIndex) {
            const wasPlaying = this.isPlaying;
            this.loadTimelineClip(targetClipIndex);

            // Seek to position after clip loads
            setTimeout(() => {
                this.seekWithinCurrentClip(timeInClipMs / 1000); // Convert to seconds
                if (wasPlaying) {
                    this.playAllVideos();
                }
                // Clear flag after seeking is complete
                setTimeout(() => {
                    this.isUpdatingTimeline = false;
                }, 100);
            }, 200);
        } else {
            // Same clip - just seek
            this.seekWithinCurrentClip(timeInClipMs / 1000);
            // Clear flag after seeking is complete
            setTimeout(() => {
                this.isUpdatingTimeline = false;
            }, 100);
        }

        // Set the current position for timeline display
        // Convert actual position to continuous position for display
        const continuousPosition = this.actualToContinuousPosition(globalPositionMs);
        this.currentTimeline.currentPosition = continuousPosition;
        
        // Update timeline display with the correct position
        this.updateTimelineDisplay();
    }

    updateAccurateTimelineDuration() {
        if (!this.currentTimeline || !this.currentTimeline.sortedClips) return;

        const clips = this.currentTimeline.sortedClips;
        if (clips.length === 0) return;

        // Store previous duration for comparison
        const previousDisplayDuration = this.currentTimeline.displayDuration;

        // Calculate continuous timeline duration (excluding gaps)
        let continuousDuration = 0;
        let knownClips = 0;

        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            // Use actual duration from the clip group
            const actualDuration = clip.duration || 60000; // 60 seconds default
            continuousDuration += actualDuration;
            knownClips++;
        }

        // Update timeline duration with continuous duration (excluding gaps)
        this.currentTimeline.totalDuration = continuousDuration;
        this.currentTimeline.displayDuration = continuousDuration;

        console.log(`📏 Updated continuous timeline duration: ${Math.round(continuousDuration/1000)}s (${knownClips}/${clips.length} clips with actual durations)`);

        // Re-render event markers if duration changed significantly
        if (Math.abs(previousDisplayDuration - continuousDuration) > 1000) { // More than 1 second difference
            console.log(`📊 Re-rendering event markers due to timeline duration change: ${Math.round(previousDisplayDuration/1000)}s → ${Math.round(continuousDuration/1000)}s`);
            
            // Reset the rendered flag to allow re-rendering
            this.currentTimeline.eventMarkersRendered = false;
            
            // Re-render event markers
            this.renderEventMarkers();
        }
    }

    loadTimelineClip(clipIndex) {
        if (!this.currentTimeline || clipIndex >= this.currentTimeline.clips.length) {
            return;
        }

        const clip = this.currentTimeline.clips[clipIndex];
        this.currentTimeline.currentClipIndex = clipIndex;

        // Set as current clip group for compatibility with existing video loading
        this.currentClipGroup = clip;
        this.loadClipGroupVideos(clip);

        console.log(`Loaded timeline clip ${clipIndex + 1}/${this.currentTimeline.clips.length}`);

        // Notify debug manager of clip change
        if (this.debugManager) {
            document.dispatchEvent(new CustomEvent('clipChanged', {
                detail: {
                    clip: clip,
                    clipIndex: clipIndex,
                    totalClips: this.currentTimeline.clips.length
                }
            }));
        }
    }

    createTimelineSegments(clips) {
        if (clips.length === 0) return [];

        const segments = [];
        let currentSegment = {
            startIndex: 0,
            endIndex: 0,
            startTime: new Date(clips[0].timestamp),
            endTime: new Date(clips[0].timestamp),
            duration: 60, // Each clip is 60 seconds
            clipCount: 1
        };

        const sortedClips = [...clips].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        for (let i = 1; i < sortedClips.length; i++) {
            const prevTime = new Date(sortedClips[i - 1].timestamp);
            const currentTime = new Date(sortedClips[i].timestamp);
            const gap = (currentTime - prevTime) / 1000; // seconds

            console.log(`🧩 Segment check: ${prevTime.toLocaleTimeString()} -> ${currentTime.toLocaleTimeString()}: ${gap}s gap`);

            // If gap is larger than 2 minutes, start a new segment
            if (gap > 120) {
                console.log(`🔄 Starting new segment due to ${Math.round(gap / 60)} minute gap`);
                // Finalize current segment - duration is number of clips * 60 seconds
                currentSegment.endIndex = i - 1;
                currentSegment.endTime = prevTime;
                currentSegment.duration = currentSegment.clipCount * 60; // 60 seconds per clip
                segments.push(currentSegment);

                console.log(`📊 Segment ${segments.length}: ${currentSegment.clipCount} clips, ${currentSegment.duration}s duration`);

                // Start new segment
                currentSegment = {
                    startIndex: i,
                    endIndex: i,
                    startTime: currentTime,
                    endTime: currentTime,
                    duration: 60, // Start with 60 seconds for first clip
                    clipCount: 1
                };
            } else {
                // Continue current segment
                currentSegment.endIndex = i;
                currentSegment.endTime = currentTime;
                currentSegment.clipCount++;
                currentSegment.duration = currentSegment.clipCount * 60; // Update duration
            }
        }

        // Add the final segment
        currentSegment.duration = currentSegment.clipCount * 60; // Final duration calculation
        segments.push(currentSegment);

        console.log(`📊 Final Segment ${segments.length}: ${currentSegment.clipCount} clips, ${currentSegment.duration}s duration`);

        return segments;
    }

    calculateActualDuration(segments) {
        // Calculate total duration of actual available footage
        return segments.reduce((total, segment) => total + segment.duration, 0) * 1000; // milliseconds
    }

    calculateCoverage(segments) {
        if (segments.length === 0) return 0;

        const firstTime = segments[0].startTime;
        const lastTime = segments[segments.length - 1].endTime;
        const totalTimeSpan = (lastTime - firstTime) / 1000; // seconds
        const actualFootage = segments.reduce((total, segment) => total + segment.duration, 0);

        return totalTimeSpan > 0 ? (actualFootage / totalTimeSpan) * 100 : 100;
    }

    detectTimelineGaps(clips) {
        const gaps = [];
        const sortedClips = [...clips].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        for (let i = 0; i < sortedClips.length - 1; i++) {
            const currentClip = sortedClips[i];
            const nextClip = sortedClips[i + 1];
            const currentTime = new Date(currentClip.timestamp);
            const nextTime = new Date(nextClip.timestamp);

            // Calculate actual gap (time between clip starts minus expected clip duration)
            const timeBetweenClips = (nextTime - currentTime) / 1000; // seconds
            const expectedInterval = 60; // Tesla clips are typically 60 seconds
            const gapDuration = timeBetweenClips - expectedInterval;

            console.log(`🔍 Gap Detection: ${currentTime.toLocaleTimeString()} -> ${nextTime.toLocaleTimeString()}: ${timeBetweenClips}s interval, ${gapDuration}s gap`);

            if (gapDuration > 120) { // Gaps larger than 2 minutes
                gaps.push({
                    startTime: new Date(currentTime.getTime() + 60000), // End of current clip
                    endTime: nextTime,
                    duration: gapDuration,
                    beforeClipIndex: i,
                    afterClipIndex: i + 1
                });
                console.log(`📍 Gap detected: ${Math.round(gapDuration / 60)} minutes`);
            }
        }

        return gaps;
    }

    calculateFootagePosition(clipIndex, timeInClip) {
        // Calculate position within available footage (excluding gaps)
        if (!this.currentTimeline || !this.currentTimeline.segments) {
            return clipIndex * 60000 + timeInClip; // Fallback to old method
        }

        let footagePosition = 0;
        const segments = this.currentTimeline.segments;

        // Find which segment contains the current clip
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];

            if (clipIndex >= segment.startIndex && clipIndex <= segment.endIndex) {
                // Current clip is in this segment
                const clipsBeforeInSegment = clipIndex - segment.startIndex;
                const positionInSegment = (clipsBeforeInSegment * 60000) + timeInClip;
                const result = footagePosition + positionInSegment;

                console.log(`📍 Clip ${clipIndex} in segment ${i + 1}: ${clipsBeforeInSegment} clips before + ${Math.round(timeInClip/1000)}s = ${Math.round(result/1000)}s total`);
                return result;
            } else if (clipIndex > segment.endIndex) {
                // Current clip is after this segment, add full segment duration
                footagePosition += segment.duration * 1000; // Convert to milliseconds
                console.log(`⏭️ Adding segment ${i + 1} duration: ${segment.duration}s, total now: ${Math.round(footagePosition/1000)}s`);
            } else {
                // Current clip is before this segment (shouldn't happen)
                break;
            }
        }

        return footagePosition;
    }

    getCameraDisplayName(camera) {
        const displayNames = {
            'front': 'Front',
            'left_repeater': 'Left Rep',
            'right_repeater': 'Right Rep',
            'left_pillar': 'Left Pil',
            'right_pillar': 'Right Pil',
            'back': 'Back'
        };
        return displayNames[camera] || camera;
    }

    async selectClipGroup(index) {
        if (index < 0 || index >= this.clipGroups.length) {
            return;
        }

        try {
            // Update UI to show selected clip
            document.querySelectorAll('.clip-item').forEach((item, i) => {
                item.classList.toggle('active', i === index);
            });

            this.currentClipGroup = this.clipGroups[index];
            
            // Load videos for this clip group
            await this.loadClipGroupVideos(this.currentClipGroup);
            
            console.log('Selected clip group:', this.currentClipGroup);
            
        } catch (error) {
            console.error('Failed to select clip group:', error);
            this.showError('Failed to load clip', error.message);
        }
    }

    async loadClipGroupVideos(clipGroup) {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];

        // Reset all videos first
        cameras.forEach(camera => {
            const video = this.videos[camera];
            const overlay = video.parentElement.querySelector('.video-overlay');

            if (clipGroup.files[camera]) {
                // Load video file
                video.src = `file://${clipGroup.files[camera].path}`;
                overlay.style.display = 'none';

                // Set up event listeners for continuous playback
                video.removeEventListener('ended', this.handleVideoEnded);
                video.addEventListener('ended', this.handleVideoEnded.bind(this));

                // Set up time update for timeline tracking
                video.removeEventListener('timeupdate', this.handleTimeUpdate);
                video.addEventListener('timeupdate', this.handleTimeUpdate.bind(this));

            } else {
                // No video for this camera
                video.src = '';
                overlay.style.display = 'flex';
                overlay.querySelector('.video-status').textContent = 'No video available';
            }
        });

        // Update duration - use timeline duration if available, otherwise single clip duration
        if (this.currentTimeline) {
            this.duration = this.currentTimeline.totalDuration / 1000; // Convert to seconds
        } else {
            this.duration = clipGroup.duration || 60; // Default 60 seconds if unknown
        }

        // Restore playback speed for all videos
        if (this.config.playbackSpeed) {
            Object.keys(this.videos).forEach(camera => {
                const video = this.videos[camera];
                if (video && video.src) {
                    video.playbackRate = this.config.playbackSpeed;
                }
            });
        }

        this.updateTimelineDisplay();
    }

    handleVideoEnded() {
        // Prevent multiple rapid auto-advancements
        if (this.isAutoAdvancing) {
            console.log('🚫 Auto-advancement already in progress, ignoring video ended event');
            return;
        }

        // Auto-advance using the same logic as manual (which works!)
        if (this.currentTimeline && this.currentTimeline.currentClipIndex < this.currentTimeline.clips.length - 1) {
            console.log('Auto-advancing to next clip using working manual logic');
            this.autoAdvanceToNextClip();
        } else {
            console.log('Reached end of timeline');
            this.pauseAllVideos();
        }
    }

    manualNextClip() {
        if (!this.currentTimeline) {
            console.log('No timeline loaded');
            return;
        }

        const currentClipIndex = this.currentTimeline.currentClipIndex;
        const nextClipIndex = currentClipIndex + 1;

        if (nextClipIndex >= this.currentTimeline.clips.length) {
            console.log('Already at last clip');
            return;
        }

        console.log(`🎬 Manually advancing from clip ${currentClipIndex + 1} to clip ${nextClipIndex + 1}`);

        // Simply load the next clip and start from beginning
        this.loadTimelineClip(nextClipIndex);

        // Start playing the new clip from time 0
        setTimeout(() => {
            Object.keys(this.videos).forEach(camera => {
                const video = this.videos[camera];
                if (video && video.src) {
                    video.currentTime = 0;
                    video.play();
                }
            });
        }, 200);
    }

    autoAdvanceToNextClip() {
        // Set lock to prevent multiple rapid advancements
        this.isAutoAdvancing = true;

        // Safety timeout to release lock if something goes wrong
        setTimeout(() => {
            if (this.isAutoAdvancing) {
                console.warn('⚠️ Auto-advancement lock timeout - releasing lock');
                this.isAutoAdvancing = false;
            }
        }, 5000); // 5 second timeout

        // Use the EXACT same logic as manual advancement (which works!)
        if (!this.currentTimeline) {
            console.log('No timeline loaded');
            this.isAutoAdvancing = false;
            return;
        }

        const currentClipIndex = this.currentTimeline.currentClipIndex;
        const nextClipIndex = currentClipIndex + 1;

        if (nextClipIndex >= this.currentTimeline.clips.length) {
            console.log('Already at last clip');
            this.isAutoAdvancing = false;
            return;
        }

        // Load next clip
        this.loadTimelineClip(nextClipIndex);

        // Continue playing if we were playing
        setTimeout(() => {
            this.playAllVideos();

            // Release lock after advancement is complete
            setTimeout(() => {
                this.isAutoAdvancing = false;
            }, 1000);
        }, 200);
    }

    handleTimeUpdate(event) {
        // Don't update timeline position while user is seeking or dragging markers
        if (this.isSeekingTimeline || this.isUpdatingTimeline || this.isDraggingMarker) {
            console.log('🚫 Blocked timeline update during seeking or marker dragging');
            return;
        }

        if (this.currentTimeline && this.currentTimeline.accurateTimeline) {
            // Use continuous timeline positioning
            const currentClipTime = event.target.currentTime * 1000; // Convert to milliseconds
            
            // Calculate continuous position (excluding gaps)
            let continuousPosition = 0;
            const clips = this.currentTimeline.sortedClips;
            
            // Find the current clip in sortedClips by matching timestamp
            const currentClip = this.currentTimeline.clips[this.currentTimeline.currentClipIndex];
            let sortedClipIndex = 0;
            
            if (currentClip && clips) {
                for (let i = 0; i < clips.length; i++) {
                    if (clips[i].timestamp === currentClip.timestamp) {
                        sortedClipIndex = i;
                        break;
                    }
                }
            }
            
            // Add durations of all clips before current clip
            for (let i = 0; i < sortedClipIndex; i++) {
                const clip = clips[i];
                const clipDuration = clip.duration || 60000;
                continuousPosition += clipDuration;
            }
            
            // Add current time within current clip
            continuousPosition += currentClipTime;
            
            // Store continuous position for smooth timeline display
            this.currentTimeline.currentPosition = continuousPosition;
            this.throttledUpdateTimelineDisplay();
        } else if (this.currentTimeline) {
            // Fallback to old method for non-accurate timelines
            const currentClipTime = event.target.currentTime * 1000; // Convert to milliseconds
            let globalPosition = 0;

            // Add durations of all clips before current clip
            for (let i = 0; i < this.currentTimeline.currentClipIndex; i++) {
                const actualDuration = this.currentTimeline.actualDurations[i];
                globalPosition += actualDuration || 60000; // Use actual duration or default 60s
            }

            // Add current time within current clip
            globalPosition += currentClipTime;

            this.currentTimeline.currentPosition = globalPosition;
            this.throttledUpdateTimelineDisplay();
        } else {
            // Single clip mode - update current time
            this.currentTime = event.target.currentTime;
            this.throttledUpdateTimelineDisplay();
        }
    }

    advanceToNextClip() {
        if (!this.currentTimeline) return;

        const nextClipIndex = this.currentTimeline.currentClipIndex + 1;
        if (nextClipIndex < this.currentTimeline.clips.length) {
            const wasPlaying = this.isPlaying;

            // Load next clip
            this.loadTimelineClip(nextClipIndex);

            // Continue playing if we were playing
            if (wasPlaying) {
                // Small delay to ensure video is loaded
                setTimeout(() => {
                    this.playAllVideos();
                }, 100);
            }
        }
    }

    advanceToNextAvailableClip() {
        if (!this.currentTimeline) return;

        const currentClipIndex = this.currentTimeline.currentClipIndex;
        const nextClipIndex = currentClipIndex + 1;

        if (nextClipIndex >= this.currentTimeline.clips.length) {
            console.log('Reached end of available clips');
            this.pauseAllVideos();
            return;
        }

        console.log(`🎬 Advancing from clip ${currentClipIndex + 1} to clip ${nextClipIndex + 1}`);

        // Calculate position based on actual durations of clips so far
        let currentPosition = 0;
        for (let i = 0; i < currentClipIndex; i++) {
            const clipDuration = (this.currentTimeline.clips[i].duration || 60) * 1000;
            currentPosition += clipDuration;
        }
        // Add the full duration of the clip that just ended
        const endedClipDuration = (this.currentTimeline.clips[currentClipIndex].duration || 60) * 1000;
        currentPosition += endedClipDuration;

        console.log(`📊 Position calculation: ${currentClipIndex + 1} clips completed = ${Math.round(currentPosition/1000)}s`);

        // Simply load the next clip
        const wasPlaying = this.isPlaying;
        this.loadTimelineClip(nextClipIndex);

        // AGGRESSIVELY force all videos to time 0 and start playing immediately
        if (wasPlaying) {
            setTimeout(() => {
                console.log(`🚀 FORCING all videos to time 0 and immediate playback`);

                // Force every video to time 0
                Object.keys(this.videos).forEach(camera => {
                    const video = this.videos[camera];
                    if (video && video.src) {
                        video.currentTime = 0;
                        console.log(`🎯 FORCED ${camera} to time 0`);
                    }
                });

                // Force immediate playback
                this.playAllVideos();

                // Double-check after a short delay
                setTimeout(() => {
                    Object.keys(this.videos).forEach(camera => {
                        const video = this.videos[camera];
                        if (video && video.src && video.currentTime > 5) {
                            console.log(`⚠️ ${camera} jumped to ${video.currentTime}s - forcing back to 0`);
                            video.currentTime = 0;
                        }
                    });
                }, 100);

            }, 100);
        }
    }

    // Playback Control Methods
    async togglePlayPause() {
        if (this.isPlaying) {
            this.pauseAllVideos();
        } else {
            this.playAllVideos();
        }
    }

    async playAllVideos() {
        if (!this.currentClipGroup) {
            console.warn('No clip group selected');
            return;
        }

        try {
            const playPromises = Object.keys(this.currentClipGroup.files).map(camera => {
                const video = this.videos[camera];
                if (video && video.src) {
                    return video.play();
                }
                return Promise.resolve();
            });

            await Promise.all(playPromises);
            this.isPlaying = true;
            this.updatePlayPauseButton();

            // Start time update loop
            this.startTimeUpdateLoop();

        } catch (error) {
            // Ignore play interruption errors (common during seeking)
            if (error.name === 'AbortError' || error.message.includes('interrupted by a new load request')) {
                console.log('Play request interrupted (normal during seeking)');
                return;
            }

            console.error('Failed to play videos:', error);
            this.showError('Playback Error', 'Failed to start video playback');
        }
    }

    pauseAllVideos() {
        Object.keys(this.videos).forEach(camera => {
            const video = this.videos[camera];
            if (video && !video.paused) {
                video.pause();
            }
        });

        this.isPlaying = false;
        this.updatePlayPauseButton();
        this.stopTimeUpdateLoop();
    }

    stopPlayback() {
        this.pauseAllVideos();
        this.seekToPosition(0);
    }

    debouncedSeek(position) {
        // Clear any existing seek timeout
        if (this.seekTimeout) {
            clearTimeout(this.seekTimeout);
        }

        // Set a new timeout to seek after user stops dragging
        this.seekTimeout = setTimeout(() => {
            console.log(`🎯 Debounced seek to position ${position}%`);
            this.seekToPosition(position);
        }, 150); // Wait 150ms after user stops dragging
    }

    seekToPosition(position) {
        console.log(`🎯 Seeking to position ${position}%`);
        if (this.currentTimeline && this.currentTimeline.accurateTimeline) {
            // Use continuous timeline positioning (percentage of continuous duration)
            const continuousPositionMs = (position / 100) * this.currentTimeline.displayDuration;
            console.log(`🎯 Continuous target position: ${Math.round(continuousPositionMs/1000)}s`);
            
            // Convert continuous position to actual position (including gaps) for video seeking
            const actualPositionMs = this.continuousToActualPosition(continuousPositionMs);
            console.log(`🎯 Actual target position: ${Math.round(actualPositionMs/1000)}s`);
            
            // Store the continuous position for timeline display consistency
            this.currentTimeline.currentPosition = continuousPositionMs;
            
            this.seekToAccurateGlobalPosition(actualPositionMs);
        } else if (this.currentTimeline) {
            // Timeline mode - use stable display duration for consistent scrubber
            const targetPositionMs = (position / 100) * this.currentTimeline.displayDuration;
            console.log(`🎯 Target position: ${Math.round(targetPositionMs/1000)}s`);
            this.seekToGlobalPosition(targetPositionMs);
        } else {
            // Single clip mode
            const timeInSeconds = (position / 100) * this.duration;

            Object.keys(this.videos).forEach(camera => {
                const video = this.videos[camera];
                if (video && video.src) {
                    video.currentTime = timeInSeconds;
                }
            });

            this.currentTime = timeInSeconds;
            this.updateTimelineDisplay();
        }
    }

    seekToActualPosition(targetPositionMs) {
        if (!this.currentTimeline || !this.currentTimeline.segments) return;

        // Find which segment and clip contains the target footage position
        let accumulatedDuration = 0;
        let targetSegment = null;
        let targetClipIndex = 0;
        let positionInClip = 0;

        for (let i = 0; i < this.currentTimeline.segments.length; i++) {
            const segment = this.currentTimeline.segments[i];
            const segmentDurationMs = segment.duration * 1000;

            if (targetPositionMs <= accumulatedDuration + segmentDurationMs) {
                targetSegment = segment;
                const positionInSegment = targetPositionMs - accumulatedDuration;

                // Calculate which clip within the segment
                const clipDurationMs = 60000; // Assume 60 seconds per clip
                const clipIndexInSegment = Math.floor(positionInSegment / clipDurationMs);
                positionInClip = positionInSegment % clipDurationMs;

                // Calculate absolute clip index
                targetClipIndex = Math.min(segment.startIndex + clipIndexInSegment, segment.endIndex);
                break;
            }

            accumulatedDuration += segmentDurationMs;
        }

        if (!targetSegment) {
            // Target position is beyond available footage, go to last clip
            const lastSegment = this.currentTimeline.segments[this.currentTimeline.segments.length - 1];
            targetClipIndex = lastSegment.endIndex;
            positionInClip = 60000; // End of clip
        }

        // Load the target clip if different from current
        if (targetClipIndex !== this.currentTimeline.currentClipIndex) {
            const wasPlaying = this.isPlaying;
            this.loadTimelineClip(targetClipIndex);

            // Seek to position after clip loads
            setTimeout(() => {
                this.seekWithinCurrentClip(positionInClip / 1000); // Convert to seconds
                if (wasPlaying) {
                    this.playAllVideos();
                }
            }, 100);
        } else {
            // Same clip, just seek within it
            this.seekWithinCurrentClip(positionInClip / 1000);
        }

        // Update timeline position to exact target (footage position)
        this.currentTimeline.currentPosition = targetPositionMs;
        this.updateTimelineDisplay();
    }

    seekWithinCurrentClip(timeInSeconds) {
        Object.keys(this.videos).forEach(camera => {
            const video = this.videos[camera];
            if (video && !isNaN(video.duration)) {
                video.currentTime = Math.min(timeInSeconds, video.duration);
            }
        });
    }

    seekToGlobalPosition(globalPositionMs) {
        if (!this.currentTimeline) return;

        // Calculate which clip and position within clip using actual durations
        let accumulatedTime = 0;
        let targetClipIndex = 0;
        let positionInClipMs = globalPositionMs;

        // Find which clip contains the target position
        for (let i = 0; i < this.currentTimeline.clips.length; i++) {
            const clipDuration = this.currentTimeline.actualDurations[i] || 60000; // Use actual or default

            if (accumulatedTime + clipDuration > globalPositionMs) {
                targetClipIndex = i;
                positionInClipMs = globalPositionMs - accumulatedTime;
                break;
            }

            accumulatedTime += clipDuration;
        }

        // Ensure target clip index is valid
        const validClipIndex = Math.min(targetClipIndex, this.currentTimeline.clips.length - 1);

        if (validClipIndex !== this.currentTimeline.currentClipIndex) {
            // Need to switch clips
            const wasPlaying = this.isPlaying;
            this.loadTimelineClip(validClipIndex);

            // Seek to position after clip loads
            setTimeout(() => {
                const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
                cameras.forEach(camera => {
                    const video = this.videos[camera];
                    if (video && video.src) {
                        video.currentTime = positionInClipMs / 1000;
                        // Restore playback speed
                        if (this.config.playbackSpeed) {
                            video.playbackRate = this.config.playbackSpeed;
                        }
                    }
                });

                if (wasPlaying) {
                    this.playAllVideos();
                }
            }, 200);
        } else {
            // Same clip - just seek
            const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
            cameras.forEach(camera => {
                const video = this.videos[camera];
                if (video && video.src) {
                    video.currentTime = positionInClipMs / 1000;
                }
            });
        }

        this.currentTimeline.currentPosition = globalPositionMs;
        this.updateTimelineDisplay();
    }

    setPlaybackSpeed(speed) {
        Object.keys(this.videos).forEach(camera => {
            const video = this.videos[camera];
            if (video) {
                video.playbackRate = speed;
            }
        });

        // Store the current playback speed in config
        this.config.playbackSpeed = speed;
    }

    setVolume(volume) {
        Object.keys(this.videos).forEach(camera => {
            const video = this.videos[camera];
            if (video) {
                video.volume = volume;
                video.muted = volume === 0;
            }
        });

        // Save to config (disabled for now)
        // window.electronAPI.config.set('defaultVolume', volume);
    }

    previousClip() {
        if (!this.currentClipGroup) return;

        const currentIndex = this.clipGroups.indexOf(this.currentClipGroup);
        if (currentIndex > 0) {
            this.selectClipGroup(currentIndex - 1);
        }
    }

    nextClip() {
        if (!this.currentClipGroup) return;

        const currentIndex = this.clipGroups.indexOf(this.currentClipGroup);
        if (currentIndex < this.clipGroups.length - 1) {
            this.selectClipGroup(currentIndex + 1);
        }
    }

    // Video Event Handlers
    onVideoLoaded(camera) {
        const video = this.videos[camera];
        console.log(`Video loaded for ${camera}: ${video.duration}s`);

        // Update duration if this video is longer
        if (video.duration > this.duration) {
            this.duration = video.duration;
            this.updateTimelineDisplay();
        }

        // Update timeline duration dynamically
        if (this.currentTimeline && camera === 'front') {
            const clipIndex = this.currentTimeline.currentClipIndex;
            const durationMs = video.duration * 1000; // Convert to milliseconds
            
            // Update both arrays for consistency
            this.currentTimeline.actualDurations[clipIndex] = durationMs;
            
            // Update the sortedClips array for accurate timeline calculations
            if (this.currentTimeline.sortedClips) {
                const currentClip = this.currentTimeline.clips[clipIndex];
                // Find the matching clip in sortedClips by timestamp
                for (let i = 0; i < this.currentTimeline.sortedClips.length; i++) {
                    if (this.currentTimeline.sortedClips[i].timestamp === currentClip.timestamp) {
                        this.currentTimeline.sortedClips[i].duration = durationMs;
                        break;
                    }
                }
            }
            
            this.currentTimeline.loadedClipCount++;

            // Check for truly corrupted clips (extremely short)
            if (video.duration < 1) { // Less than 1 second is likely corrupted
                console.warn(`⚠️ Corrupted clip detected: Clip ${clipIndex + 1} is only ${video.duration}s`);
                this.handleCorruptedClip(clipIndex);
                return;
            }

            // Update accurate timeline duration
            if (this.currentTimeline.accurateTimeline) {
                this.updateAccurateTimelineDuration();
            } else {
                // Update dynamic total duration estimate for legacy timelines
                this.updateDynamicTimelineDuration();
            }

            console.log(`📏 Clip ${clipIndex + 1} duration: ${video.duration}s | Loaded: ${this.currentTimeline.loadedClipCount}/${this.currentTimeline.clips.length} | Display: ${Math.round(this.currentTimeline.displayDuration/1000)}s | Total: ${Math.round(this.currentTimeline.totalDuration/1000)}s`);
        }
    }

    recalculateTimelineDuration() {
        if (!this.currentTimeline) return;

        // Calculate total duration using actual clip durations where available
        const totalDuration = this.currentTimeline.clips.reduce((total, clip) => {
            return total + ((clip.duration || 60) * 1000); // Use actual duration or default to 60s
        }, 0);

        const oldDuration = this.currentTimeline.totalDuration;
        this.currentTimeline.totalDuration = totalDuration;

        console.log(`🔄 Timeline duration updated: ${Math.round(oldDuration/60000)}min -> ${Math.round(totalDuration/60000)}min`);
    }

    updateDynamicTimelineDuration() {
        if (!this.currentTimeline) return;

        // Calculate current estimate based on what we know so far
        let knownDuration = 0;
        let knownClips = 0;

        // Add up all known clip durations
        for (let i = 0; i < this.currentTimeline.clips.length; i++) {
            const actualDuration = this.currentTimeline.actualDurations[i];
            if (actualDuration !== undefined) {
                knownDuration += actualDuration;
                knownClips++;
            }
        }

        // Always update working duration for calculations
        if (knownClips > 0) {
            if (knownClips === this.currentTimeline.clips.length) {
                // All clips loaded, use exact total
                this.currentTimeline.totalDuration = knownDuration;
                this.currentTimeline.displayDuration = knownDuration;
                console.log(`📏 Final timeline duration: ${Math.round(knownDuration/1000)}s (exact from ${knownClips} clips) - updating display`);
                this.updateTimelineDisplay();

                // Update the sidebar duration display
                this.updateSidebarDuration(knownDuration);
            } else {
                // Estimate based on loaded clips, but also update display for better UX
                const averageDuration = knownDuration / knownClips;
                const unknownClips = this.currentTimeline.clips.length - knownClips;
                const estimatedTotal = knownDuration + (unknownClips * averageDuration);

                this.currentTimeline.totalDuration = estimatedTotal;

                // For small timelines (≤3 clips), wait for all clips before updating display
                // For larger timelines, update when we have most clips loaded
                const shouldUpdateDisplay = this.currentTimeline.clips.length > 3 ?
                    knownClips >= Math.ceil(this.currentTimeline.clips.length * 0.8) :
                    false; // Wait for exact duration on small timelines

                if (shouldUpdateDisplay) {
                    this.currentTimeline.displayDuration = estimatedTotal;
                    console.log(`📏 Estimated timeline duration: ${Math.round(estimatedTotal/1000)}s (from ${knownClips}/${this.currentTimeline.clips.length} clips, avg: ${Math.round(averageDuration/1000)}s)`);
                    this.updateTimelineDisplay();
                } else {
                    console.log(`📏 Calculated estimate: ${Math.round(estimatedTotal/1000)}s (waiting for more clips before updating display)`);
                }
            }
        }
    }

    onVideoTimeUpdate(camera) {
        // Use front camera as the reference for time updates
        if (camera === 'front' && !this.isSeekingTimeline) {
            const video = this.videos[camera];
            this.currentTime = video.currentTime;
            this.throttledUpdateTimelineDisplay();
        }
    }

    onVideoEnded(camera) {
        console.log(`Video ended for ${camera}`);

        // If all videos have ended, stop playback
        const allEnded = Object.keys(this.videos).every(cam => {
            const video = this.videos[cam];
            return !video.src || video.ended;
        });

        if (allEnded) {
            this.isPlaying = false;
            this.updatePlayPauseButton();
            this.stopTimeUpdateLoop();
        }
    }

    onVideoError(camera, error) {
        console.error(`Video error for ${camera}:`, error);

        const video = this.videos[camera];
        const overlay = video.parentElement.querySelector('.video-overlay');
        overlay.style.display = 'flex';
        overlay.querySelector('.video-status').textContent = 'Error loading video';
    }

    // UI Update Methods
    updatePlayPauseButton() {
        const playPauseBtn = document.getElementById('play-pause-btn');
        const icon = playPauseBtn.querySelector('.icon');

        if (this.isPlaying) {
            icon.textContent = '⏸️';
            playPauseBtn.title = 'Pause';
        } else {
            icon.textContent = '▶️';
            playPauseBtn.title = 'Play';
        }
    }

    updateTimelineDisplay() {
        // Prevent infinite loops
        if (this.isUpdatingDisplay) {
            return;
        }
        this.isUpdatingDisplay = true;

        // Set flag to prevent event marker re-rendering during timeline updates
        this.isUpdatingTimeline = true;

        // Update timeline scrubber
        const timelineScrubber = document.getElementById('timeline-scrubber');

        if (this.currentTimeline) {
            // Timeline mode - use continuous timeline positioning
            if (this.currentTimeline.displayDuration > 0) {
                // Use continuous position directly (no conversion needed)
                const percentage = Math.min(100, Math.max(0,
                    (this.currentTimeline.currentPosition / this.currentTimeline.displayDuration) * 100
                ));
                timelineScrubber.value = percentage;
            }
        } else {
            // Single clip mode
            if (this.duration > 0) {
                const percentage = (this.currentTime / this.duration) * 100;
                timelineScrubber.value = percentage;
            }
        }

        // Update time display
        const currentTimeEl = document.getElementById('current-time');
        const totalTimeEl = document.getElementById('total-time');

        if (this.currentTimeline) {
            // Timeline mode - show continuous timeline time (excluding gaps)
            const currentSeconds = Math.floor(this.currentTimeline.currentPosition / 1000);
            const totalSeconds = Math.floor(this.currentTimeline.displayDuration / 1000);

            // Use simple time format for timeline (like video players)
            currentTimeEl.textContent = this.formatTime(currentSeconds);
            totalTimeEl.textContent = this.formatTime(totalSeconds);
        } else {
            // Single clip mode
            currentTimeEl.textContent = this.formatTime(this.currentTime);
            totalTimeEl.textContent = this.formatTime(this.duration);
        }

        // Release the update guards
        this.isUpdatingDisplay = false;
        
        // Clear timeline update flag after a short delay
        setTimeout(() => {
            this.isUpdatingTimeline = false;
        }, 50);
    }

    throttledUpdateTimelineDisplay() {
        // Throttle timeline updates to prevent infinite loops during playback
        if (this.timelineUpdateTimeout) {
            return; // Update already scheduled
        }

        this.timelineUpdateTimeout = setTimeout(() => {
            this.updateTimelineDisplay();
            this.timelineUpdateTimeout = null;
        }, 100); // Update at most every 100ms
    }

    updateSidebarDuration(actualDurationMs) {
        if (!this.currentTimeline) return;

        // Find the active date item in the sidebar
        const activeDateItem = document.querySelector('.date-item.active');
        if (!activeDateItem) return;

        // Update the duration display
        const durationElement = activeDateItem.querySelector('.date-duration');
        if (!durationElement) return;

        // Calculate and format the new duration
        const totalMinutes = Math.floor(actualDurationMs / 60000);
        const totalHours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;

        let durationText = '';
        if (totalHours > 0) {
            durationText = `${totalHours}h ${remainingMinutes}m`;
        } else if (totalMinutes > 0) {
            durationText = `${totalMinutes}m`;
        } else {
            // Show seconds for very short timelines
            const totalSeconds = Math.floor(actualDurationMs / 1000);
            durationText = `${totalSeconds}s`;
        }

        durationElement.textContent = durationText;
    }

    setupStickyHeaders() {
        // Set up intersection observer for sticky header effects
        const sidebarContent = document.getElementById('sidebar-content');
        if (!sidebarContent) return;

        // Create intersection observer to detect when headers become sticky
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const header = entry.target;
                if (entry.isIntersecting) {
                    // Header is visible normally
                    header.classList.remove('sticky');
                } else {
                    // Header is sticky (out of normal view)
                    header.classList.add('sticky');
                }
            });
        }, {
            root: sidebarContent,
            rootMargin: '-1px 0px 0px 0px',
            threshold: [0, 1]
        });

        // Observe all section headers
        const headers = document.querySelectorAll('.section-header');
        headers.forEach(header => observer.observe(header));

        // Store observer for cleanup
        this.stickyHeaderObserver = observer;
    }

    setupExportSystem() {
        // Initialize export markers
        this.exportMarkers = {
            start: null,
            end: null
        };

        // Set up export control event listeners
        const setStartMarkerBtn = document.getElementById('set-start-marker');
        const setEndMarkerBtn = document.getElementById('set-end-marker');
        const clearMarkersBtn = document.getElementById('clear-markers');
        const exportVideoBtn = document.getElementById('export-video');

        setStartMarkerBtn?.addEventListener('click', () => this.setExportMarker('start'));
        setEndMarkerBtn?.addEventListener('click', () => this.setExportMarker('end'));
        clearMarkersBtn?.addEventListener('click', () => this.clearExportMarkers());
        exportVideoBtn?.addEventListener('click', () => this.openExportDialog());

        // Set up export modal event listeners
        const exportModal = document.getElementById('export-modal');
        const closeModalBtn = document.getElementById('close-export-modal');
        const cancelExportBtn = document.getElementById('cancel-export');
        const startExportBtn = document.getElementById('start-export');

        closeModalBtn?.addEventListener('click', () => this.closeExportDialog());
        cancelExportBtn?.addEventListener('click', async () => {
            console.log('Renderer: Cancel button clicked, exportId:', this.currentExportId);
            if (this.currentExportId) {
                await window.electronAPI.tesla.cancelExport(this.currentExportId);
                this.currentExportId = null;
            }
            this.closeExportDialog();
        });
        startExportBtn?.addEventListener('click', () => this.startVideoExport());

        // Close modal when clicking outside
        exportModal?.addEventListener('click', (e) => {
            if (e.target === exportModal) {
                this.closeExportDialog();
            }
        });

        // Update export info when settings change
        const qualityInputs = document.querySelectorAll('input[name="export-quality"]');
        const cameraToggles = document.querySelectorAll('.camera-export-toggle');
        // const hwaccelToggle = document.getElementById('hwaccel-enabled');
        // if (hwaccelToggle) {
        //     hwaccelToggle.disabled = true;
        //     hwaccelToggle.checked = false;
        //     hwaccelToggle.title = 'Hardware acceleration is temporarily disabled';
        // }

        qualityInputs.forEach(input => {
            input.addEventListener('change', () => {
                this.updateExportEstimates();
                this.updateTimelapsePreview();
            });
        });

        cameraToggles.forEach(toggle => {
            toggle.addEventListener('change', () => {
                this.updateExportEstimates();
                this.updateTimelapsePreview();
            });
        });

        // Timelapse event listeners
        const timelapseToggle = document.getElementById('timelapse-enabled');
        const timelapseSettings = document.getElementById('timelapse-settings');
        const timelapseSpeed = document.getElementById('timelapse-speed');

        timelapseToggle?.addEventListener('change', (e) => {
            const isTimelapseEnabled = e.target.checked;
            const timestampEnabled = document.getElementById('timestamp-overlay-enabled');

            console.log('🎬 Timelapse toggle changed:', isTimelapseEnabled);
            console.log('🎬 Timestamp element found:', !!timestampEnabled);

            // Show/hide timelapse settings
            if (timelapseSettings) {
                timelapseSettings.classList.toggle('hidden', !isTimelapseEnabled);
            }

            // Auto-disable/enable timestamps based on timelapse mode
            if (timestampEnabled) {
                if (isTimelapseEnabled) {
                    // Store the previous state so we can restore it later
                    if (!timestampEnabled.hasAttribute('data-previous-state')) {
                        timestampEnabled.setAttribute('data-previous-state', timestampEnabled.checked);
                    }
                    timestampEnabled.checked = false;
                    timestampEnabled.disabled = true;

                    // Add visual indication that timestamps are disabled for timelapse
                    const timestampOption = timestampEnabled.closest('.export-option');
                    if (timestampOption) {
                        timestampOption.classList.add('disabled');
                        timestampOption.title = 'Timestamps are automatically disabled during timelapse export';
                    }

                    console.log('🎬 Timelapse enabled: Auto-disabled timestamps');
                } else {
                    // Re-enable timestamps and restore previous state
                    timestampEnabled.disabled = false;

                    // Remove visual indication
                    const timestampOption = timestampEnabled.closest('.export-option');
                    if (timestampOption) {
                        timestampOption.classList.remove('disabled');
                        timestampOption.title = '';
                    }

                    // Restore previous state if it was stored
                    const previousState = timestampEnabled.getAttribute('data-previous-state');
                    if (previousState !== null) {
                        timestampEnabled.checked = previousState === 'true';
                        timestampEnabled.removeAttribute('data-previous-state');
                    }

                    console.log('🎬 Timelapse disabled: Re-enabled timestamps');
                }
            }

            this.updateTimelapsePreview();
            this.updateExportEstimates();
        });

        timelapseSpeed?.addEventListener('change', () => {
            this.updateTimelapsePreview();
            this.updateExportEstimates();
        });

        // hwaccelToggle?.addEventListener('change', () => this.updateExportEstimates());

        // Initialize flexible camera layout system
        this.initializeFlexibleCameraLayout();
    }

    initializeFlexibleCameraLayout() {
        // Initialize camera layout state
        this.cameraLayout = {
            positions: new Map(), // camera -> {x, y, width, height}
            snapThreshold: 10,    // pixels for magnetic snapping
            gridSize: 20          // snap grid size
        };

        // Set up drag and drop for camera layout
        this.setupCameraLayoutDragDrop();

        // Initialize default layout
        this.initializeDefaultCameraLayout();
    }

    setupCameraLayoutDragDrop() {
        const canvas = document.getElementById('camera-layout-canvas');
        const sidebar = document.querySelector('.camera-sidebar');

        if (!canvas || !sidebar) return;

        let draggedElement = null;
        let dragOffset = { x: 0, y: 0 };
        let snapGuides = [];

        // Handle drag start from sidebar
        sidebar.addEventListener('dragstart', (e) => {
            const cameraItem = e.target.closest('.camera-item');
            if (!cameraItem) return;

            draggedElement = cameraItem;
            cameraItem.classList.add('dragging');

            // Store drag offset for positioned items
            if (cameraItem.classList.contains('positioned')) {
                const rect = cameraItem.getBoundingClientRect();
                dragOffset.x = e.clientX - rect.left;
                dragOffset.y = e.clientY - rect.top;
            } else {
                dragOffset.x = cameraItem.offsetWidth / 2;
                dragOffset.y = cameraItem.offsetHeight / 2;
            }

            console.log('🎬 Started dragging camera:', cameraItem.dataset.camera);
        });

        // Handle drag end
        document.addEventListener('dragend', (e) => {
            if (draggedElement) {
                draggedElement.classList.remove('dragging');
                this.clearSnapGuides();
                draggedElement = null;
            }
        });

        // Handle canvas drag over
        canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            canvas.classList.add('drag-over');

            if (draggedElement) {
                this.showSnapGuides(e, draggedElement);
            }
        });

        // Handle canvas drag leave
        canvas.addEventListener('dragleave', (e) => {
            // Only remove drag-over if we're actually leaving the canvas
            if (!canvas.contains(e.relatedTarget)) {
                canvas.classList.remove('drag-over');
                this.clearSnapGuides();
            }
        });

        // Handle canvas drop
        canvas.addEventListener('drop', (e) => {
            e.preventDefault();
            canvas.classList.remove('drag-over');
            this.clearSnapGuides();

            if (!draggedElement) return;

            const camera = draggedElement.dataset.camera;
            const canvasRect = canvas.getBoundingClientRect();

            // Calculate position relative to canvas
            let x = e.clientX - canvasRect.left - dragOffset.x;
            let y = e.clientY - canvasRect.top - dragOffset.y;

            // Apply snapping
            const snappedPos = this.applySnapping(x, y, draggedElement);
            x = snappedPos.x;
            y = snappedPos.y;

            // Ensure camera stays within canvas bounds
            const maxX = canvas.offsetWidth - 100; // Assume min camera width of 100px
            const maxY = canvas.offsetHeight - 60;  // Assume min camera height of 60px
            x = Math.max(0, Math.min(x, maxX));
            y = Math.max(0, Math.min(y, maxY));

            this.positionCameraOnCanvas(camera, x, y);
            console.log(`🎬 Positioned camera ${camera} at (${x}, ${y})`);
        });

        // Handle repositioning of cameras already on canvas
        canvas.addEventListener('mousedown', (e) => {
            const cameraItem = e.target.closest('.camera-item.positioned');
            if (!cameraItem) return;

            e.preventDefault();
            const camera = cameraItem.dataset.camera;
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = parseInt(cameraItem.style.left) || 0;
            const startTop = parseInt(cameraItem.style.top) || 0;

            cameraItem.classList.add('dragging');

            const handleMouseMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;

                let newX = startLeft + deltaX;
                let newY = startTop + deltaY;

                // Apply snapping
                const snappedPos = this.applySnapping(newX, newY, cameraItem);
                newX = snappedPos.x;
                newY = snappedPos.y;

                // Keep within bounds
                const maxX = canvas.offsetWidth - cameraItem.offsetWidth;
                const maxY = canvas.offsetHeight - cameraItem.offsetHeight;
                newX = Math.max(0, Math.min(newX, maxX));
                newY = Math.max(0, Math.min(newY, maxY));

                cameraItem.style.left = `${newX}px`;
                cameraItem.style.top = `${newY}px`;

                this.updateCameraPosition(camera, newX, newY);
            };

            const handleMouseUp = () => {
                cameraItem.classList.remove('dragging');
                this.clearSnapGuides();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    }

    initializeDefaultCameraLayout() {
        // Set up default camera positions based on main UI visibility state
        const canvas = document.getElementById('camera-layout-canvas');
        if (!canvas) return;

        // Define 3x2 grid positions with NO gaps (seamless layout)
        const cameraWidth = 100;  // Width of each camera
        const cameraHeight = 60;  // Height of each camera
        const startX = 20;        // Starting X position
        const startY = 20;        // Starting Y position

        const defaultPositions = {
            'left_pillar': { x: startX, y: startY },                           // Top row, left
            'front': { x: startX + cameraWidth, y: startY },                   // Top row, center (no gap)
            'right_pillar': { x: startX + (cameraWidth * 2), y: startY },      // Top row, right (no gap)
            'left_repeater': { x: startX, y: startY + cameraHeight },          // Bottom row, left (no gap)
            'back': { x: startX + cameraWidth, y: startY + cameraHeight },     // Bottom row, center (no gap)
            'right_repeater': { x: startX + (cameraWidth * 2), y: startY + cameraHeight } // Bottom row, right (no gap)
        };

        const allCameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];

        // Clear any existing positioned cameras
        canvas.querySelectorAll('.camera-item.positioned').forEach(item => item.remove());

        // Reset all cameras to sidebar initially
        allCameras.forEach(camera => {
            const cameraItem = document.querySelector(`.camera-item[data-camera="${camera}"]`);
            const toggle = cameraItem?.querySelector('.camera-export-toggle');

            if (cameraItem && toggle) {
                // Check main UI visibility state
                const isVisibleInMainUI = this.cameraVisibility && this.cameraVisibility[camera];

                if (isVisibleInMainUI) {
                    // Camera is visible in main UI - position it on canvas
                    const position = defaultPositions[camera];
                    if (position) {
                        this.positionCameraOnCanvas(camera, position.x, position.y);
                        console.log(`🎬 Auto-positioned ${camera} on canvas (visible in main UI)`);
                    }
                } else {
                    // Camera is hidden in main UI - keep in sidebar as disabled
                    toggle.checked = false;
                    cameraItem.classList.add('disabled');
                    cameraItem.style.display = 'flex'; // Ensure it's visible in sidebar
                    cameraItem.style.visibility = 'visible'; // Ensure visibility
                    console.log(`🎬 Kept ${camera} in sidebar (hidden in main UI)`);
                }
            }
        });

        this.updateCanvasInstructions();

        // Log the initialization result
        const positionedCount = canvas.querySelectorAll('.camera-item.positioned').length;
        const visibleCount = Object.values(this.cameraVisibility || {}).filter(v => v).length;
        console.log(`🎬 Camera layout initialized: ${positionedCount}/${visibleCount} visible cameras positioned on canvas`);

        // Debug: Check actual DOM state
        this.debugCameraLayoutDOM();
    }

    positionCameraOnCanvas(camera, x, y) {
        const canvas = document.getElementById('camera-layout-canvas');
        const sidebar = document.querySelector('.camera-sidebar');

        if (!canvas || !sidebar) return;

        // Find camera item in sidebar
        let cameraItem = sidebar.querySelector(`.camera-item[data-camera="${camera}"]`);
        if (!cameraItem) return;

        // Clone the camera item for canvas positioning
        const canvasItem = cameraItem.cloneNode(true);
        canvasItem.classList.add('positioned');
        canvasItem.classList.remove('disabled');
        canvasItem.style.left = `${x}px`;
        canvasItem.style.top = `${y}px`;

        // CRITICAL FIX: Ensure the cloned item is visible
        canvasItem.style.display = 'flex';
        canvasItem.style.visibility = 'visible';

        // Remove any existing positioned version of this camera
        const existingItem = canvas.querySelector(`.camera-item[data-camera="${camera}"]`);
        if (existingItem) {
            existingItem.remove();
        }

        // Add to canvas
        canvas.appendChild(canvasItem);

        // Update camera position in state
        this.updateCameraPosition(camera, x, y);

        // Check the camera toggle (positioned = enabled)
        const sidebarToggle = cameraItem.querySelector('.camera-export-toggle');
        const canvasToggle = canvasItem.querySelector('.camera-export-toggle');
        if (sidebarToggle && canvasToggle) {
            sidebarToggle.checked = true;
            canvasToggle.checked = true;
        }

        // Hide camera in sidebar (but keep it for reference)
        cameraItem.style.display = 'none';
        cameraItem.classList.remove('disabled');

        // Update instructions
        this.updateCanvasInstructions();

        // Set up double-click to remove from canvas
        canvasItem.addEventListener('dblclick', () => {
            this.removeCameraFromCanvas(camera);
        });

        console.log(`🎬 Camera ${camera} positioned on canvas and enabled`);
    }

    removeCameraFromCanvas(camera) {
        const canvas = document.getElementById('camera-layout-canvas');
        const sidebar = document.querySelector('.camera-sidebar');

        if (!canvas || !sidebar) return;

        // Remove from canvas
        const canvasItem = canvas.querySelector(`.camera-item[data-camera="${camera}"]`);
        if (canvasItem) {
            canvasItem.remove();
        }

        // Show in sidebar again and uncheck (sidebar = disabled)
        const sidebarItem = sidebar.querySelector(`.camera-item[data-camera="${camera}"]`);
        const sidebarToggle = sidebarItem?.querySelector('.camera-export-toggle');

        if (sidebarItem) {
            sidebarItem.style.display = 'flex';
            sidebarItem.style.visibility = 'visible'; // Ensure visibility
            sidebarItem.classList.add('disabled');
        }

        if (sidebarToggle) {
            sidebarToggle.checked = false; // Uncheck when in sidebar
        }

        // Remove from position state
        this.cameraLayout.positions.delete(camera);

        // Update instructions
        this.updateCanvasInstructions();

        console.log(`🎬 Removed camera ${camera} from canvas and disabled`);
    }

    updateCameraPosition(camera, x, y) {
        this.cameraLayout.positions.set(camera, {
            x: x,
            y: y,
            width: 100, // Default width
            height: 60  // Default height
        });
    }

    applySnapping(x, y, element) {
        const canvas = document.getElementById('camera-layout-canvas');
        if (!canvas) return { x, y };

        const snapThreshold = this.cameraLayout.snapThreshold;
        const cameraWidth = 100;
        const cameraHeight = 60;

        let snappedX = x;
        let snappedY = y;

        // Get all other positioned cameras
        const otherCameras = canvas.querySelectorAll('.camera-item.positioned');
        const occupiedPositions = [];

        otherCameras.forEach(otherCamera => {
            if (otherCamera === element) return;

            const otherX = parseInt(otherCamera.style.left) || 0;
            const otherY = parseInt(otherCamera.style.top) || 0;
            occupiedPositions.push({ x: otherX, y: otherY, width: cameraWidth, height: cameraHeight });
        });

        // Check if position would overlap with any existing camera
        const wouldOverlap = (testX, testY) => {
            return occupiedPositions.some(pos => {
                return !(testX >= pos.x + pos.width ||
                        testX + cameraWidth <= pos.x ||
                        testY >= pos.y + pos.height ||
                        testY + cameraHeight <= pos.y);
            });
        };

        // First, check for center-point snapping opportunities (prioritize these)
        const centerCandidates = [];
        this.addCenterPointCandidates(occupiedPositions, centerCandidates, cameraWidth, cameraHeight);

        // Check if we're close to any center-point positions
        const snapDistance = 30; // Increased snap distance for center points
        for (const candidate of centerCandidates) {
            const distance = Math.sqrt(Math.pow(x - candidate.x, 2) + Math.pow(y - candidate.y, 2));
            if (distance < snapDistance && !wouldOverlap(candidate.x, candidate.y)) {
                console.log(`🎯 Snapping to center point: (${candidate.x}, ${candidate.y}) - ${candidate.type}`);
                return { x: candidate.x, y: candidate.y };
            }
        }

        // If the current position would overlap, find the closest non-overlapping position
        if (wouldOverlap(snappedX, snappedY)) {
            const candidates = [];

            // For each occupied position, calculate potential snap positions
            occupiedPositions.forEach(pos => {
                // Right side of existing camera
                candidates.push({ x: pos.x + pos.width, y: pos.y, type: 'right-side' });
                // Left side of existing camera
                candidates.push({ x: pos.x - cameraWidth, y: pos.y, type: 'left-side' });
                // Below existing camera
                candidates.push({ x: pos.x, y: pos.y + pos.height, type: 'below' });
                // Above existing camera
                candidates.push({ x: pos.x, y: pos.y - cameraHeight, type: 'above' });
            });

            // Add center-point candidates as backup options
            candidates.push(...centerCandidates);

            // Add grid positions as candidates
            const startX = 20, startY = 20;
            for (let row = 0; row < 3; row++) {
                for (let col = 0; col < 4; col++) {
                    candidates.push({
                        x: startX + (col * cameraWidth),
                        y: startY + (row * cameraHeight)
                    });
                }
            }

            // Filter out candidates that would still overlap or are out of bounds
            const validCandidates = candidates.filter(candidate => {
                return candidate.x >= 0 &&
                       candidate.y >= 0 &&
                       candidate.x + cameraWidth <= canvas.offsetWidth &&
                       candidate.y + cameraHeight <= canvas.offsetHeight &&
                       !wouldOverlap(candidate.x, candidate.y);
            });

            // Find the closest valid position
            if (validCandidates.length > 0) {
                let closestCandidate = validCandidates[0];
                let minDistance = Math.sqrt(Math.pow(x - closestCandidate.x, 2) + Math.pow(y - closestCandidate.y, 2));

                validCandidates.forEach(candidate => {
                    const distance = Math.sqrt(Math.pow(x - candidate.x, 2) + Math.pow(y - candidate.y, 2));
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestCandidate = candidate;
                    }
                });

                snappedX = closestCandidate.x;
                snappedY = closestCandidate.y;

                console.log(`🧲 Snapped to closest non-overlapping position: (${snappedX}, ${snappedY})`);
            }
        }

        // Edge snapping (keep within canvas bounds)
        snappedX = Math.max(0, Math.min(snappedX, canvas.offsetWidth - cameraWidth));
        snappedY = Math.max(0, Math.min(snappedY, canvas.offsetHeight - cameraHeight));

        return { x: snappedX, y: snappedY };
    }

    addCenterPointCandidates(occupiedPositions, candidates, cameraWidth, cameraHeight) {
        // Find center points between adjacent cameras
        for (let i = 0; i < occupiedPositions.length; i++) {
            for (let j = i + 1; j < occupiedPositions.length; j++) {
                const pos1 = occupiedPositions[i];
                const pos2 = occupiedPositions[j];

                // Check if cameras are horizontally adjacent (same Y, touching X)
                if (Math.abs(pos1.y - pos2.y) < 5) { // Same row (allowing small tolerance)
                    if (Math.abs((pos1.x + pos1.width) - pos2.x) < 5 || Math.abs((pos2.x + pos2.width) - pos1.x) < 5) {
                        // Cameras are horizontally adjacent
                        const leftCamera = pos1.x < pos2.x ? pos1 : pos2;
                        const rightCamera = pos1.x < pos2.x ? pos2 : pos1;

                        // Center point above the gap
                        const centerX = leftCamera.x + ((rightCamera.x - leftCamera.x - cameraWidth) / 2) + (cameraWidth / 2);
                        candidates.push({
                            x: centerX - (cameraWidth / 2),
                            y: leftCamera.y - cameraHeight,
                            type: 'center-above'
                        });

                        // Center point below the gap
                        candidates.push({
                            x: centerX - (cameraWidth / 2),
                            y: leftCamera.y + cameraHeight,
                            type: 'center-below'
                        });

                        console.log(`🎯 Added center-point candidates between cameras at Y=${leftCamera.y}`);
                    }
                }

                // Check if cameras are vertically adjacent (same X, touching Y)
                if (Math.abs(pos1.x - pos2.x) < 5) { // Same column (allowing small tolerance)
                    if (Math.abs((pos1.y + pos1.height) - pos2.y) < 5 || Math.abs((pos2.y + pos2.height) - pos1.y) < 5) {
                        // Cameras are vertically adjacent
                        const topCamera = pos1.y < pos2.y ? pos1 : pos2;
                        const bottomCamera = pos1.y < pos2.y ? pos2 : pos1;

                        // Center point to the left of the gap
                        const centerY = topCamera.y + ((bottomCamera.y - topCamera.y - cameraHeight) / 2) + (cameraHeight / 2);
                        candidates.push({
                            x: topCamera.x - cameraWidth,
                            y: centerY - (cameraHeight / 2),
                            type: 'center-left'
                        });

                        // Center point to the right of the gap
                        candidates.push({
                            x: topCamera.x + cameraWidth,
                            y: centerY - (cameraHeight / 2),
                            type: 'center-right'
                        });

                        console.log(`🎯 Added center-point candidates between cameras at X=${topCamera.x}`);
                    }
                }

                // Special case: Center between two cameras that form a gap
                // This handles cases like your example where Front centers between Left/Right Repeater
                if (Math.abs(pos1.y - pos2.y) < 5) { // Same row
                    const leftCamera = pos1.x < pos2.x ? pos1 : pos2;
                    const rightCamera = pos1.x < pos2.x ? pos2 : pos1;
                    const gapWidth = rightCamera.x - (leftCamera.x + leftCamera.width);

                    // If there's a gap between cameras, add center position
                    if (gapWidth >= cameraWidth) {
                        const centerX = leftCamera.x + leftCamera.width + (gapWidth - cameraWidth) / 2;
                        candidates.push({
                            x: centerX,
                            y: leftCamera.y,
                            type: 'gap-center-same-row'
                        });
                        console.log(`🎯 Added gap-center candidate at (${centerX}, ${leftCamera.y})`);
                    }

                    // Also add center position above the gap (for cameras from different rows)
                    const centerX = leftCamera.x + leftCamera.width + (gapWidth - cameraWidth) / 2;
                    candidates.push({
                        x: centerX,
                        y: leftCamera.y - cameraHeight,
                        type: 'gap-center-above'
                    });
                    candidates.push({
                        x: centerX,
                        y: leftCamera.y + cameraHeight,
                        type: 'gap-center-below'
                    });
                    console.log(`🎯 Added gap-center above/below candidates at X=${centerX}`);
                }
            }
        }
    }

    showSnapGuides(event, element) {
        // This would show visual snap guides - simplified for now
        // In a full implementation, you'd create visual guide lines
    }

    clearSnapGuides() {
        const canvas = document.getElementById('camera-layout-canvas');
        if (!canvas) return;

        // Remove any existing snap guides
        canvas.querySelectorAll('.snap-guide').forEach(guide => guide.remove());
    }

    updateCanvasInstructions() {
        const canvas = document.getElementById('camera-layout-canvas');
        const instructions = canvas?.querySelector('.canvas-instructions');

        if (!instructions) return;

        const positionedCameras = canvas.querySelectorAll('.camera-item.positioned');

        if (positionedCameras.length === 0) {
            instructions.textContent = 'Drag cameras from the sidebar to arrange your custom layout';
            instructions.classList.remove('hidden');
        } else {
            instructions.classList.add('hidden');
        }
    }

    debugCameraLayoutDOM() {
        const canvas = document.getElementById('camera-layout-canvas');
        const sidebar = document.querySelector('.camera-sidebar');

        console.log('🔍 DEBUG: Camera Layout DOM State');
        console.log('Canvas element:', canvas);
        console.log('Sidebar element:', sidebar);

        if (canvas) {
            const positionedCameras = canvas.querySelectorAll('.camera-item.positioned');
            console.log(`Canvas positioned cameras: ${positionedCameras.length}`);
            positionedCameras.forEach((camera, index) => {
                console.log(`  Camera ${index + 1}:`, {
                    dataset: camera.dataset.camera,
                    position: `${camera.style.left}, ${camera.style.top}`,
                    visible: camera.offsetWidth > 0 && camera.offsetHeight > 0,
                    classes: camera.className,
                    display: getComputedStyle(camera).display,
                    visibility: getComputedStyle(camera).visibility
                });
            });

            const instructions = canvas.querySelector('.canvas-instructions');
            console.log('Canvas instructions:', {
                element: instructions,
                hidden: instructions?.classList.contains('hidden'),
                text: instructions?.textContent
            });
        }

        if (sidebar) {
            const sidebarCameras = sidebar.querySelectorAll('.camera-item');
            console.log(`Sidebar cameras: ${sidebarCameras.length}`);
            sidebarCameras.forEach((camera, index) => {
                console.log(`  Sidebar Camera ${index + 1}:`, {
                    dataset: camera.dataset.camera,
                    visible: camera.style.display !== 'none',
                    classes: camera.className
                });
            });
        }
    }

    // Convert canvas camera layout to FFMPEG layout parameters
    generateFFMPEGLayout() {
        const positionedCameras = [];
        const canvas = document.getElementById('camera-layout-canvas');

        if (!canvas || !this.cameraLayout || !this.cameraLayout.positions) {
            console.warn('🎬 No camera layout available for export');
            return null;
        }

        // Get canvas dimensions for scaling calculations
        const canvasWidth = canvas.offsetWidth;
        const canvasHeight = canvas.offsetHeight;

        // Standard Tesla camera resolution (from FFMPEG handler)
        const ffmpegCameraWidth = 1448;
        const ffmpegCameraHeight = 938;

        // Canvas camera dimensions (from our layout system)
        const canvasCameraWidth = 100;
        const canvasCameraHeight = 60;

        // Calculate scaling factors
        const scaleX = ffmpegCameraWidth / canvasCameraWidth;
        const scaleY = ffmpegCameraHeight / canvasCameraHeight;

        // First pass: collect all canvas positions to find bounding box
        const canvasPositions = [];
        this.cameraLayout.positions.forEach((position, camera) => {
            canvasPositions.push({
                camera: camera,
                x: position.x,
                y: position.y,
                width: canvasCameraWidth,
                height: canvasCameraHeight
            });
        });

        // Calculate bounding box of all cameras on canvas
        let minX = Math.min(...canvasPositions.map(pos => pos.x));
        let minY = Math.min(...canvasPositions.map(pos => pos.y));
        let maxX = Math.max(...canvasPositions.map(pos => pos.x + pos.width));
        let maxY = Math.max(...canvasPositions.map(pos => pos.y + pos.height));

        // Calculate canvas layout dimensions (tight bounding box)
        const canvasLayoutWidth = maxX - minX;
        const canvasLayoutHeight = maxY - minY;

        console.log(`🎬 Canvas positions:`, canvasPositions);
        console.log(`🎬 Canvas bounding box: (${minX}, ${minY}) to (${maxX}, ${maxY})`);
        console.log(`🎬 Canvas layout size: ${canvasLayoutWidth}x${canvasLayoutHeight}`);

        // Convert each positioned camera to FFMPEG coordinates (normalized to start from 0,0)
        this.cameraLayout.positions.forEach((position, camera) => {
            // Normalize canvas coordinates (subtract minimum values to start from 0,0)
            const normalizedX = position.x - minX;
            const normalizedY = position.y - minY;

            // Scale normalized coordinates to FFMPEG coordinates
            const ffmpegX = Math.round(normalizedX * scaleX);
            const ffmpegY = Math.round(normalizedY * scaleY);

            positionedCameras.push({
                camera: camera,
                x: ffmpegX,
                y: ffmpegY,
                width: ffmpegCameraWidth,
                height: ffmpegCameraHeight,
                canvasPosition: { x: position.x, y: position.y },
                normalizedPosition: { x: normalizedX, y: normalizedY }
            });

            console.log(`🎬 Camera ${camera}: Canvas(${position.x}, ${position.y}) → Normalized(${normalizedX}, ${normalizedY}) → FFMPEG(${ffmpegX}, ${ffmpegY})`);
        });

        // Calculate total output dimensions based on normalized layout
        const totalWidth = Math.round(canvasLayoutWidth * scaleX);
        const totalHeight = Math.round(canvasLayoutHeight * scaleY);

        const layout = {
            cameras: positionedCameras,
            totalWidth: totalWidth,
            totalHeight: totalHeight,
            canvasWidth: canvasWidth,
            canvasHeight: canvasHeight,
            scaleFactors: { x: scaleX, y: scaleY },
            boundingBox: {
                canvas: { width: canvasLayoutWidth, height: canvasLayoutHeight },
                ffmpeg: { width: totalWidth, height: totalHeight }
            }
        };

        console.log(`🎬 Generated FFMPEG layout: ${positionedCameras.length} cameras, ${totalWidth}x${totalHeight} total size (tight bounding box)`);
        return layout;
    }

    // Get cameras selected for export (positioned on canvas)
    getExportCameras() {
        const exportCameras = [];

        if (this.cameraLayout && this.cameraLayout.positions) {
            this.cameraLayout.positions.forEach((position, camera) => {
                exportCameras.push(camera);
            });
        }

        console.log(`🎬 Export cameras: ${exportCameras.join(', ')}`);
        return exportCameras;
    }

    // Test function to manually trigger camera layout (for debugging)
    testCameraLayout() {
        console.log('🧪 Testing camera layout...');
        this.initializeDefaultCameraLayout();
        setTimeout(() => {
            this.debugCameraLayoutDOM();

            // Test FFMPEG layout generation
            console.log('🧪 Testing FFMPEG layout generation...');
            const ffmpegLayout = this.generateFFMPEGLayout();
            if (ffmpegLayout) {
                console.log('🎬 FFMPEG Layout Test Results:');
                console.log(`  Total cameras: ${ffmpegLayout.cameras.length}`);
                console.log(`  Output dimensions: ${ffmpegLayout.totalWidth}x${ffmpegLayout.totalHeight} (tight bounding box)`);
                console.log(`  Canvas bounding box: ${ffmpegLayout.boundingBox.canvas.width}x${ffmpegLayout.boundingBox.canvas.height}`);
                console.log(`  Scale factors: ${ffmpegLayout.scaleFactors.x.toFixed(2)}x, ${ffmpegLayout.scaleFactors.y.toFixed(2)}x`);
                ffmpegLayout.cameras.forEach((cam, index) => {
                    console.log(`  Camera ${index + 1} (${cam.camera}): Canvas(${cam.canvasPosition.x}, ${cam.canvasPosition.y}) → Normalized(${cam.normalizedPosition.x}, ${cam.normalizedPosition.y}) → FFMPEG(${cam.x}, ${cam.y})`);
                });
            }
        }, 100);
    }

    setExportMarker(type) {
        if (!this.currentTimeline) {
            alert('Please load a timeline first');
            return;
        }

        const continuousPosition = this.currentTimeline.currentPosition;
        
        // Convert continuous position to actual position for export
        const actualPosition = this.continuousToActualPosition(continuousPosition);
        
        // Store the actual position for export calculations
        this.exportMarkers[type] = actualPosition;

        // Update visual markers on timeline (using continuous position for display)
        this.updateExportMarkers();

        // Update export controls state
        this.updateExportControlsState();

        const time = Math.floor(actualPosition/1000);
        console.log(`Export ${type} marker set at ${time}s (continuous: ${Math.floor(continuousPosition/1000)}s, actual: ${Math.floor(actualPosition/1000)}s)`);
        this.showStatus(`📹 ${type.charAt(0).toUpperCase() + type.slice(1)} marker set (sync handled at export level)`);
    }

    findSyncStartPosition(targetPosition) {
        // Find the earliest position where all cameras are available and synchronized
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        let earliestSyncPosition = targetPosition;

        // Sync is now handled at the FFmpeg level, so we don't need to adjust the start marker
        // The right_repeater will be delayed by 1 second in the FFmpeg command
        console.log(`📹 Sync handled at FFmpeg level - using original position`);
        return targetPosition;

        // Fallback to original logic if no sync offset detected
        if (this.currentTimeline.accurateTimeline && this.currentTimeline.sortedClips) {
            for (let i = 0; i < this.currentTimeline.sortedClips.length; i++) {
                const clip = this.currentTimeline.sortedClips[i];
                const clipStartTime = this.calculateAccurateClipPosition(i);
                const clipEndTime = clipStartTime + (clip.duration || 60) * 1000;

                // Check if this clip has all cameras
                const availableCameras = cameras.filter(camera => clip.files[camera]);
                
                if (availableCameras.length === cameras.length) {
                    if (clipStartTime <= targetPosition && clipEndTime > targetPosition) {
                        return targetPosition;
                    } else if (clipStartTime > targetPosition) {
                        earliestSyncPosition = clipStartTime;
                        break;
                    }
                } else {
                    console.log(`📹 Clip ${i + 1} missing cameras: ${cameras.filter(c => !clip.files[c]).join(', ')}`);
                }
            }
        } else {
            // Legacy fallback
            for (let i = 0; i < this.currentTimeline.clips.length; i++) {
                const clip = this.currentTimeline.clips[i];
                const clipStartTime = this.calculateClipStartTime(i);
                const clipEndTime = clipStartTime + (clip.duration || 60) * 1000;

                // Check if this clip has all cameras
                const availableCameras = cameras.filter(camera => clip.files[camera]);
                
                if (availableCameras.length === cameras.length) {
                    if (clipStartTime <= targetPosition && clipEndTime > targetPosition) {
                        return targetPosition;
                    } else if (clipStartTime > targetPosition) {
                        earliestSyncPosition = clipStartTime;
                        break;
                    }
                } else {
                    console.log(`📹 Clip ${i + 1} missing cameras: ${cameras.filter(c => !clip.files[c]).join(', ')}`);
                }
            }
        }

        return earliestSyncPosition;
    }

    getCameraSyncOffset(clip) {
        // Check for timing differences between cameras in the same clip
        // This is a simplified approach - in a real implementation, you'd analyze video metadata
        // For now, we'll use a conservative estimate based on common Tesla camera sync issues
        
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        let maxOffset = 0;

        // Check if right_repeater is present and might have sync issues
        if (clip.files.right_repeater) {
            // Right repeater often starts 0.5-1.5 seconds after other cameras
            // Based on user feedback, it can be up to 1 second delay
            maxOffset = Math.max(maxOffset, 1000); // 1 second
        }

        // Check if left_repeater is present and might have sync issues
        if (clip.files.left_repeater) {
            // Left repeater can also have slight delays
            maxOffset = Math.max(maxOffset, 800); // 0.8 seconds
        }

        // Check if back camera is present and might have sync issues
        if (clip.files.back) {
            // Back camera can have timing differences
            maxOffset = Math.max(maxOffset, 600); // 0.6 seconds
        }

        // Try to get actual sync offset from current video playback if available
        const actualOffset = this.getActualSyncOffset();
        if (actualOffset > 0) {
            maxOffset = Math.max(maxOffset, actualOffset);
        }

        return maxOffset;
    }

    getActualSyncOffsetWithDirection() {
        // Try to detect actual sync offset and direction from current video playback
        if (!this.videos || !this.currentTimeline) {
            console.log(`📹 Sync detection: No videos or timeline available`);
            return { offset: 0, direction: 'none' };
        }

        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        let maxOffset = 0;
        let maxDirection = 'none';
        
        console.log(`📹 Starting sync detection for cameras: ${cameras.join(', ')}`);

        // Check each camera's current time (even if paused)
        cameras.forEach(camera => {
            const video = this.videos[camera];
            console.log(`📹 Checking ${camera}: video=${!!video}, src=${!!video?.src}, readyState=${video?.readyState}`);
            
            if (video && video.src && video.readyState >= 2) { // HAVE_CURRENT_DATA or higher
                const currentTime = video.currentTime * 1000; // Convert to milliseconds
                console.log(`📹 ${camera} current time: ${currentTime}ms`);
                
                // Compare with front camera (usually the reference)
                const frontVideo = this.videos.front;
                if (frontVideo && frontVideo.src && frontVideo.readyState >= 2) {
                    const frontTime = frontVideo.currentTime * 1000;
                    const offset = Math.abs(currentTime - frontTime);
                    const direction = currentTime > frontTime ? 'ahead' : 'behind';
                    
                    console.log(`📹 ${camera} vs front: offset=${offset}ms, direction=${direction}`);
                    
                    if (offset > maxOffset && offset > 100) { // Only consider significant offsets
                        maxOffset = offset;
                        maxDirection = direction;
                        console.log(`📹 Detected sync offset for ${camera}: ${offset}ms ${direction} of front camera`);
                    }
                } else {
                    console.log(`📹 Front camera not available for comparison`);
                }
            } else {
                console.log(`📹 ${camera} not ready: video=${!!video}, src=${!!video?.src}, readyState=${video?.readyState}`);
            }
        });

        // If no sync offset detected from current playback, use conservative estimate
        if (maxOffset === 0) {
            // Based on user feedback, right_repeater often starts ahead of front camera
            const rightRepeater = this.videos.right_repeater;
            const frontVideo = this.videos.front;
            
            if (rightRepeater && frontVideo && rightRepeater.readyState >= 2 && frontVideo.readyState >= 2) {
                const rightTime = rightRepeater.currentTime * 1000;
                const frontTime = frontVideo.currentTime * 1000;
                const offset = Math.abs(rightTime - frontTime);
                
                if (offset > 50) { // Even small offsets
                    maxOffset = offset;
                    maxDirection = rightTime > frontTime ? 'ahead' : 'behind';
                    console.log(`📹 Conservative sync detection for right_repeater: ${offset}ms ${maxDirection} of front camera`);
                } else {
                    // Use default conservative estimate
                    maxOffset = 1000; // 1 second
                    maxDirection = 'ahead'; // Right repeater typically starts ahead
                    console.log(`📹 Using default sync estimate: ${maxOffset}ms ${maxDirection} for right_repeater`);
                }
            }
        }

        return { offset: maxOffset, direction: maxDirection };
    }

    getActualSyncOffset() {
        // Legacy function for backward compatibility
        const { offset } = this.getActualSyncOffsetWithDirection();
        return offset;
    }

    getInitialSyncOffsetWithDirection() {
        // Check for initial sync delays when videos first start
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        let maxOffset = 0;
        let maxDirection = 'none';

        // Check if right_repeater is significantly ahead or behind
        const rightRepeater = this.videos.right_repeater;
        const frontVideo = this.videos.front;
        
        if (rightRepeater && frontVideo && rightRepeater.src && frontVideo.src) {
            const rightTime = rightRepeater.currentTime * 1000;
            const frontTime = frontVideo.currentTime * 1000;
            const offset = Math.abs(frontTime - rightTime);
            
            if (offset > 100 && offset < 2000) { // Between 0.1-2 seconds difference
                maxOffset = Math.max(maxOffset, offset);
                maxDirection = frontTime > rightTime ? 'behind' : 'ahead';
                console.log(`📹 Right repeater initial sync: ${offset}ms ${maxDirection} of front camera`);
            }
        }

        return { offset: maxOffset, direction: maxDirection };
    }

    getInitialSyncOffset() {
        // Legacy function for backward compatibility
        const { offset } = this.getInitialSyncOffsetWithDirection();
        return offset;
    }

    getSyncAdjustedExportRange() {
        // Get the sync-adjusted export range that ensures all cameras are synchronized
        // Note: exportMarkers now store actual positions (including gaps)
        let startTime = 0;
        let endTime = this.currentTimeline.totalTimelineDuration || this.currentTimeline.displayDuration;

        if (this.exportMarkers.start !== null && this.exportMarkers.end !== null) {
            // Both markers set - apply sync adjustments
            const originalStart = Math.min(this.exportMarkers.start, this.exportMarkers.end);
            const originalEnd = Math.max(this.exportMarkers.start, this.exportMarkers.end);
            
            // Apply sync adjustments (using actual positions)
            startTime = this.findSyncStartPosition(originalStart);
            endTime = this.findSyncEndPosition(originalEnd);
            
            console.log(`📹 Export range adjusted: ${Math.floor(originalStart/1000)}s → ${Math.floor(startTime/1000)}s, ${Math.floor(originalEnd/1000)}s → ${Math.floor(endTime/1000)}s`);
            
        } else if (this.exportMarkers.start !== null) {
            // Only start marker set - apply sync adjustment
            startTime = this.findSyncStartPosition(this.exportMarkers.start);
            console.log(`📹 Start marker adjusted: ${Math.floor(this.exportMarkers.start/1000)}s → ${Math.floor(startTime/1000)}s`);
            
        } else if (this.exportMarkers.end !== null) {
            // Only end marker set - apply sync adjustment
            endTime = this.findSyncEndPosition(this.exportMarkers.end);
            console.log(`📹 End marker adjusted: ${Math.floor(this.exportMarkers.end/1000)}s → ${Math.floor(endTime/1000)}s`);
        }

        return { startTime, endTime };
    }

    findSyncEndPosition(targetPosition) {
        // Find the latest position where all cameras are still available and synchronized
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        let latestSyncPosition = targetPosition;

        // Use accurate timeline positioning if available
        if (this.currentTimeline.accurateTimeline && this.currentTimeline.sortedClips) {
            // Check each clip from the end to find where cameras start dropping
            for (let i = this.currentTimeline.sortedClips.length - 1; i >= 0; i--) {
                const clip = this.currentTimeline.sortedClips[i];
                const clipStartTime = this.calculateAccurateClipPosition(i);
                const clipEndTime = clipStartTime + (clip.duration || 60) * 1000;

                // Check if this clip has all cameras
                const availableCameras = cameras.filter(camera => clip.files[camera]);
                
                if (availableCameras.length === cameras.length) {
                    // All cameras available in this clip, now check sync timing
                    const syncOffset = this.getCameraSyncOffset(clip);
                    
                    if (syncOffset > 0) {
                        // Cameras have sync offset, adjust end position
                        const adjustedClipEnd = clipEndTime - syncOffset;
                        
                        if (clipStartTime <= targetPosition && adjustedClipEnd > targetPosition) {
                            // Target position is within this clip, but need to account for sync
                            return Math.min(targetPosition, adjustedClipEnd);
                        } else if (adjustedClipEnd <= targetPosition) {
                            // This clip ends before target, use adjusted clip end
                            latestSyncPosition = adjustedClipEnd;
                            break;
                        }
                    } else {
                        // No sync offset, use original logic
                        if (clipStartTime <= targetPosition && clipEndTime > targetPosition) {
                            return targetPosition;
                        } else if (clipEndTime <= targetPosition) {
                            latestSyncPosition = clipEndTime;
                            break;
                        }
                    }
                } else {
                    // Some cameras missing, continue to previous clip
                    console.log(`📹 Clip ${i + 1} missing cameras: ${cameras.filter(c => !clip.files[c]).join(', ')}`);
                }
            }
        } else {
            // Fallback to legacy method
            for (let i = this.currentTimeline.clips.length - 1; i >= 0; i--) {
                const clip = this.currentTimeline.clips[i];
                const clipStartTime = this.calculateClipStartTime(i);
                const clipEndTime = clipStartTime + (clip.duration || 60) * 1000;

                // Check if this clip has all cameras
                const availableCameras = cameras.filter(camera => clip.files[camera]);
                
                if (availableCameras.length === cameras.length) {
                    // All cameras available in this clip, now check sync timing
                    const syncOffset = this.getCameraSyncOffset(clip);
                    
                    if (syncOffset > 0) {
                        // Cameras have sync offset, adjust end position
                        const adjustedClipEnd = clipEndTime - syncOffset;
                        
                        if (clipStartTime <= targetPosition && adjustedClipEnd > targetPosition) {
                            // Target position is within this clip, but need to account for sync
                            return Math.min(targetPosition, adjustedClipEnd);
                        } else if (adjustedClipEnd <= targetPosition) {
                            // This clip ends before target, use adjusted clip end
                            latestSyncPosition = adjustedClipEnd;
                            break;
                        }
                    } else {
                        // No sync offset, use original logic
                        if (clipStartTime <= targetPosition && clipEndTime > targetPosition) {
                            return targetPosition;
                        } else if (clipEndTime <= targetPosition) {
                            latestSyncPosition = clipEndTime;
                            break;
                        }
                    }
                } else {
                    // Some cameras missing, continue to previous clip
                    console.log(`📹 Clip ${i + 1} missing cameras: ${cameras.filter(c => !clip.files[c]).join(', ')}`);
                }
            }
        }

        return latestSyncPosition;
    }

    calculateClipStartTime(clipIndex) {
        // Calculate the start time of a clip in the timeline
        let startTime = 0;
        for (let i = 0; i < clipIndex; i++) {
            const clipDuration = (this.currentTimeline.clips[i].duration || 60) * 1000;
            startTime += clipDuration;
        }
        return startTime;
    }

    clearExportMarkers() {
        this.exportMarkers.start = null;
        this.exportMarkers.end = null;

        // Remove visual markers and range highlight
        this.updateExportMarkers();
        const timelineMarkers = document.getElementById('timeline-markers');
        if (timelineMarkers) {
            const rangeHighlight = timelineMarkers.querySelector('.export-range-highlight');
            if (rangeHighlight) rangeHighlight.remove();
        }

        // Update export controls state
        this.updateExportControlsState();

        console.log('Export markers cleared');
    }

    updateExportMarkers() {
        const timelineMarkers = document.getElementById('timeline-markers');
        if (!timelineMarkers || !this.currentTimeline) return;

        // Clear existing export markers
        const existingMarkers = timelineMarkers.querySelectorAll('.export-marker');
        existingMarkers.forEach(marker => marker.remove());

        // Remove any existing range highlight before adding a new one
        const existingHighlight = timelineMarkers.querySelector('.export-range-highlight');
        if (existingHighlight) existingHighlight.remove();

        // Add start marker (convert actual position to continuous for display)
        if (this.exportMarkers.start !== null) {
            const continuousStartPosition = this.actualToContinuousPosition(this.exportMarkers.start);
            const startMarker = this.createExportMarker('start', continuousStartPosition);
            timelineMarkers.appendChild(startMarker);
        }

        // Add end marker (convert actual position to continuous for display)
        if (this.exportMarkers.end !== null) {
            const continuousEndPosition = this.actualToContinuousPosition(this.exportMarkers.end);
            const endMarker = this.createExportMarker('end', continuousEndPosition);
            timelineMarkers.appendChild(endMarker);
        }

        // Add range highlight if both markers are set
        if (this.exportMarkers.start !== null && this.exportMarkers.end !== null) {
            const rangeHighlight = this.createExportRangeHighlight();
            timelineMarkers.appendChild(rangeHighlight);
        }
    }

    createExportMarker(type, position) {
        const marker = document.createElement('div');
        marker.className = `export-marker export-marker-${type}`;

        const percentage = (position / this.currentTimeline.displayDuration) * 100;
        marker.style.left = `${percentage}%`;

        marker.innerHTML = type === 'start' ? '📍' : '🏁';

        // Show actual timestamp in tooltip (convert continuous position back to actual for timestamp)
        const actualPosition = this.continuousToActualPosition(position);
        const actualTimestamp = this.calculateActualTimestamp(actualPosition);
        const timeDisplay = actualTimestamp ?
            actualTimestamp.toLocaleTimeString('en-US', { hour12: true }) :
            this.formatTime(Math.floor(actualPosition/1000));
        marker.title = `${type.charAt(0).toUpperCase() + type.slice(1)} marker: ${timeDisplay}`;

        // Make marker draggable
        this.makeMarkerDraggable(marker, type);

        return marker;
    }

    createExportRangeHighlight() {
        const highlight = document.createElement('div');
        highlight.className = 'export-range-highlight';

        const startPos = Math.min(this.exportMarkers.start, this.exportMarkers.end);
        const endPos = Math.max(this.exportMarkers.start, this.exportMarkers.end);

        // Convert actual positions to continuous positions for visual display
        const continuousStartPosition = this.actualToContinuousPosition(startPos);
        const continuousEndPosition = this.actualToContinuousPosition(endPos);

        const startPercentage = (continuousStartPosition / this.currentTimeline.displayDuration) * 100;
        const endPercentage = (continuousEndPosition / this.currentTimeline.displayDuration) * 100;

        highlight.style.left = `${startPercentage}%`;
        highlight.style.width = `${endPercentage - startPercentage}%`;

        return highlight;
    }

    makeMarkerDraggable(marker, type) {
        let isDragging = false;
        let dragListener = null;
        let upListener = null;

        marker.style.cursor = 'grab';

        marker.addEventListener('mousedown', (e) => {
            isDragging = true;
            this.isDraggingMarker = true; // Set flag to prevent timeline updates
            marker.style.cursor = 'grabbing';
            e.preventDefault();

            dragListener = (moveEvent) => {
                if (!isDragging) return;
                const timelineScrubber = document.getElementById('timeline-scrubber');
                const rect = timelineScrubber.getBoundingClientRect();
                const percentage = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
                const continuousPosition = (percentage / 100) * this.currentTimeline.displayDuration;
                
                // Convert continuous position to actual position for storage
                const actualPosition = this.continuousToActualPosition(continuousPosition);
                this.exportMarkers[type] = actualPosition;
                
                this.updateExportMarkers();
                
                // Use the correct seeking method based on timeline type
                if (this.currentTimeline && this.currentTimeline.accurateTimeline) {
                    // Use accurate timeline seeking for continuous position
                    this.seekToAccurateGlobalPosition(actualPosition);
                } else {
                    // Fallback to legacy seeking method
                    this.seekToGlobalPosition(continuousPosition);
                }
            };

            upListener = () => {
                if (isDragging) {
                    isDragging = false;
                    this.isDraggingMarker = false; // Clear flag to allow timeline updates
                    marker.style.cursor = 'grab';
                    this.updateExportControlsState();
                    document.removeEventListener('mousemove', dragListener);
                    document.removeEventListener('mouseup', upListener);
                }
            };

            document.addEventListener('mousemove', dragListener);
            document.addEventListener('mouseup', upListener);
        });
    }

    updateExportControlsState() {
        const exportBtn = document.getElementById('export-video');
        const clearBtn = document.getElementById('clear-markers');

        const hasMarkers = this.exportMarkers.start !== null || this.exportMarkers.end !== null;

        if (clearBtn) {
            clearBtn.disabled = !hasMarkers;
        }

        if (exportBtn) {
            exportBtn.disabled = !this.currentTimeline;
        }
    }

    openExportDialog() {
        if (!this.currentTimeline) {
            alert('Please load a timeline first');
            return;
        }

        const modal = document.getElementById('export-modal');
        if (!modal) return;

        // Initialize camera layout based on main UI visibility state
        this.initializeDefaultCameraLayout();

        // Sync camera visibility from main grid to export modal
        this.syncExportCameraVisibility();

        // Update export range display
        this.updateExportRangeDisplay();

        // Update camera toggles based on current visibility
        this.updateCameraExportToggles();

        // Calculate initial estimates
        this.updateExportEstimates();

        // Detect hardware acceleration
        this.detectHardwareAcceleration();

        // Show modal
        modal.classList.remove('hidden');

        // Validate export settings and update error message/button state
        this.validateExportSettings();

        // Re-validate on any change
        const cameraToggles = document.querySelectorAll('.camera-export-toggle');
        cameraToggles.forEach(toggle => toggle.addEventListener('change', () => this.validateExportSettings()));
        const qualityInputs = document.querySelectorAll('input[name="export-quality"]');
        qualityInputs.forEach(input => input.addEventListener('change', () => this.validateExportSettings()));
        const startBtn = document.getElementById('set-start-marker');
        const endBtn = document.getElementById('set-end-marker');
        if (startBtn) startBtn.addEventListener('click', () => setTimeout(() => this.validateExportSettings(), 10));
        if (endBtn) endBtn.addEventListener('click', () => setTimeout(() => this.validateExportSettings(), 10));

        const cancelExportBtn = document.getElementById('cancel-export-btn');
        if (cancelExportBtn) {
            cancelExportBtn.disabled = true;
            console.log('Cancel button disabled: waiting for export process to start');
        }
    }

    syncExportCameraVisibility() {
        // For each camera, check if it is visible in the main grid (using cameraVisibility state)
        const cameraNames = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        cameraNames.forEach(camera => {
            const isVisible = this.cameraVisibility && this.cameraVisibility[camera];
            const toggle = document.querySelector(`.camera-slot[data-camera="${camera}"] .camera-export-toggle`);
            if (toggle) {
                toggle.checked = !!isVisible;
                // Do NOT disable or dim the toggle; allow user to re-enable for export
            }
        });
    }

    validateExportSettings() {
        const errorDiv = document.getElementById('export-error-message');
        const startExportBtn = document.getElementById('start-export');
        let error = '';

        if (!this.currentTimeline) {
            error = 'No timeline loaded.';
        } else {
            // At least one camera selected
            const selectedCameras = Array.from(document.querySelectorAll('.camera-export-toggle:checked'));
            if (selectedCameras.length === 0) {
                error = 'Please select at least one camera to export.';
            }
            // Export range valid
            const start = this.exportMarkers.start;
            const end = this.exportMarkers.end;
            if (start !== null && end !== null && start >= end) {
                error = 'Export start marker must be before end marker.';
            }
        }

        if (error) {
            if (errorDiv) {
                errorDiv.textContent = error;
                errorDiv.style.display = '';
            }
            if (startExportBtn) startExportBtn.disabled = true;
        } else {
            if (errorDiv) {
                errorDiv.textContent = '';
                errorDiv.style.display = 'none';
            }
            if (startExportBtn) startExportBtn.disabled = false;
        }
    }

    closeExportDialog() {
        const modal = document.getElementById('export-modal');
        if (!modal) return;

        modal.classList.add('hidden');

        // Hide progress if visible
        const progressSection = document.getElementById('export-progress');
        if (progressSection) {
            progressSection.classList.add('hidden');
        }
    }

    calculateActualFootageDuration(startPos, endPos) {
        // Calculate the actual footage duration within the export range, excluding gaps
        if (!this.currentTimeline || !this.currentTimeline.clips) {
            return Math.floor((endPos - startPos) / 1000); // Fallback to total span
        }

        let totalFootageDuration = 0;
        const clips = this.currentTimeline.clips;

        // Use accurate timeline logic if available
        if (this.currentTimeline.accurateTimeline && this.currentTimeline.sortedClips) {
            const sortedClips = this.currentTimeline.sortedClips;
            const timelineStartTime = this.currentTimeline.startTime.getTime();

            for (let i = 0; i < sortedClips.length; i++) {
                const clip = sortedClips[i];
                if (!clip || !clip.timestamp) continue;

                // Calculate clip position using accurate timeline logic
                const clipStartTime = new Date(clip.timestamp).getTime();
                const clipRelativeStart = clipStartTime - timelineStartTime;

                // Use actual duration if available, otherwise default to 60 seconds
                let clipDuration = 60000; // Default 60 seconds in milliseconds
                if (this.currentTimeline.actualDurations && this.currentTimeline.actualDurations[i]) {
                    clipDuration = this.currentTimeline.actualDurations[i];
                } else if (clip.duration) {
                    clipDuration = clip.duration * 1000; // Convert to milliseconds
                }

                const clipRelativeEnd = clipRelativeStart + clipDuration;

                // Check if clip overlaps with export range
                const clipOverlaps = (clipRelativeStart < endPos) && (clipRelativeEnd > startPos);

                if (clipOverlaps) {
                    // Calculate the overlapping portion
                    const overlapStart = Math.max(clipRelativeStart, startPos);
                    const overlapEnd = Math.min(clipRelativeEnd, endPos);
                    const overlapDuration = overlapEnd - overlapStart;

                    if (overlapDuration > 0) {
                        totalFootageDuration += overlapDuration;
                        console.log(`📹 Clip ${i} contributes ${Math.round(overlapDuration/1000)}s to export range`);
                    }
                }
            }
        } else {
            // Fallback to legacy sequential positioning
            let currentPosition = 0;

            for (let i = 0; i < clips.length; i++) {
                const clip = clips[i];
                if (!clip) continue;

                const clipDuration = (clip.duration || 60) * 1000; // Convert to milliseconds
                const clipRelativeStart = currentPosition;
                const clipRelativeEnd = currentPosition + clipDuration;

                // Check if clip overlaps with export range
                const clipOverlaps = (clipRelativeStart < endPos) && (clipRelativeEnd > startPos);

                if (clipOverlaps) {
                    // Calculate the overlapping portion
                    const overlapStart = Math.max(clipRelativeStart, startPos);
                    const overlapEnd = Math.min(clipRelativeEnd, endPos);
                    const overlapDuration = overlapEnd - overlapStart;

                    if (overlapDuration > 0) {
                        totalFootageDuration += overlapDuration;
                    }
                }

                currentPosition += clipDuration;
            }
        }

        const totalFootageSeconds = Math.floor(totalFootageDuration / 1000);
        const totalSpanSeconds = Math.floor((endPos - startPos) / 1000);
        const gapSeconds = totalSpanSeconds - totalFootageSeconds;

        console.log(`📊 Export range footage calculation: ${totalFootageSeconds}s footage in ${totalSpanSeconds}s span (${gapSeconds}s gaps)`);

        return totalFootageSeconds;
    }

    updateExportRangeDisplay() {
        const rangeDisplay = document.getElementById('export-range-display');
        const durationDisplay = document.getElementById('export-duration-display');

        if (!rangeDisplay || !durationDisplay) return;

        let startTime, endTime, duration;

        if (this.exportMarkers.start !== null && this.exportMarkers.end !== null) {
            const startPos = Math.min(this.exportMarkers.start, this.exportMarkers.end);
            const endPos = Math.max(this.exportMarkers.start, this.exportMarkers.end);

            // Calculate actual timestamps for the export range (using actual positions)
            const startTimestamp = this.calculateActualTimestamp(startPos);
            const endTimestamp = this.calculateActualTimestamp(endPos);

            // Calculate actual footage duration (excluding gaps)
            duration = this.calculateActualFootageDuration(startPos, endPos);

            startTime = startTimestamp ? startTimestamp.toLocaleTimeString('en-US', { hour12: true }) : this.formatTime(Math.floor(startPos / 1000));
            endTime = endTimestamp ? endTimestamp.toLocaleTimeString('en-US', { hour12: true }) : this.formatTime(Math.floor(endPos / 1000));

            rangeDisplay.textContent = `${startTime} - ${endTime}`;

            // Check for sync issues in the export range
            this.checkExportRangeSync(startPos, endPos);
        } else if (this.exportMarkers.start !== null) {
            const startTimestamp = this.calculateActualTimestamp(this.exportMarkers.start);
            startTime = startTimestamp ? startTimestamp.toLocaleTimeString('en-US', { hour12: true }) : this.formatTime(Math.floor(this.exportMarkers.start / 1000));

            // Calculate actual footage duration from start marker to end of total timeline
            const totalTimelineEnd = this.currentTimeline.totalTimelineDuration || this.currentTimeline.displayDuration;
            duration = this.calculateActualFootageDuration(this.exportMarkers.start, totalTimelineEnd);

            rangeDisplay.textContent = `${startTime} - End`;
        } else if (this.exportMarkers.end !== null) {
            const endTimestamp = this.calculateActualTimestamp(this.exportMarkers.end);
            endTime = endTimestamp ? endTimestamp.toLocaleTimeString('en-US', { hour12: true }) : this.formatTime(Math.floor(this.exportMarkers.end / 1000));

            // Calculate actual footage duration from start to end marker
            duration = this.calculateActualFootageDuration(0, this.exportMarkers.end);

            rangeDisplay.textContent = `Start - ${endTime}`;
        } else {
            // Calculate actual footage duration for full timeline
            // Use totalTimelineDuration (includes gaps) to get all clips, but function will return only footage duration
            const totalTimelineEnd = this.currentTimeline.totalTimelineDuration || this.currentTimeline.displayDuration;
            duration = this.calculateActualFootageDuration(0, totalTimelineEnd);
            rangeDisplay.textContent = 'Full Timeline';
        }

        durationDisplay.textContent = `(${this.formatTime(duration)})`;

        // Update timelapse preview when export range changes
        this.updateTimelapsePreview();
    }

    checkExportRangeSync(startPos, endPos) {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        const syncIssues = [];

        // Check each clip in the export range
        for (let i = 0; i < this.currentTimeline.clips.length; i++) {
            const clip = this.currentTimeline.clips[i];
            const clipStartTime = this.calculateClipStartTime(i);
            const clipEndTime = clipStartTime + (clip.duration || 60) * 1000;

            // Check if this clip overlaps with the export range
            if (clipStartTime < endPos && clipEndTime > startPos) {
                const availableCameras = cameras.filter(camera => clip.files[camera]);
                if (availableCameras.length < cameras.length) {
                    const missingCameras = cameras.filter(c => !clip.files[c]);
                    syncIssues.push({
                        clipIndex: i,
                        missingCameras: missingCameras,
                        timeRange: `${this.formatTime(Math.floor(Math.max(startPos, clipStartTime) / 1000))} - ${this.formatTime(Math.floor(Math.min(endPos, clipEndTime) / 1000))}`
                    });
                }
            }
        }

        // Show warning if sync issues found
        if (syncIssues.length > 0) {
            const missingCameras = [...new Set(syncIssues.flatMap(issue => issue.missingCameras))];
            console.warn(`⚠️ Export range has sync issues: ${syncIssues.length} clips missing cameras: ${missingCameras.join(', ')}`);
            
            // Update export button to show warning
            const exportBtn = document.getElementById('start-export');
            if (exportBtn) {
                exportBtn.title = `Warning: Some clips in export range are missing cameras (${missingCameras.join(', ')})`;
                exportBtn.classList.add('warning');
            }
        } else {
            // Clear warning
            const exportBtn = document.getElementById('start-export');
            if (exportBtn) {
                exportBtn.title = 'Start export';
                exportBtn.classList.remove('warning');
            }
        }
    }

    updateCameraExportToggles() {
        const cameraToggles = document.querySelectorAll('.camera-export-toggle');
        cameraToggles.forEach(toggle => {
            // Support both old camera-slot and new camera-item structures
            const cameraContainer = toggle.closest('.camera-slot') || toggle.closest('.camera-item');
            const camera = cameraContainer?.dataset.camera;
            if (camera) {
                // Use cameraVisibility state, not DOM
                const isVisible = this.cameraVisibility && this.cameraVisibility[camera];
                toggle.checked = !!isVisible;

                // Update visual state for flexible layout
                if (cameraContainer.classList.contains('camera-item')) {
                    if (isVisible) {
                        cameraContainer.classList.remove('disabled');
                        // Add to canvas if not already positioned and this is in sidebar
                        if (!cameraContainer.classList.contains('positioned') &&
                            this.cameraLayout && !this.cameraLayout.positions.has(camera)) {
                            this.addCameraToDefaultPosition(camera);
                        }
                    } else {
                        cameraContainer.classList.add('disabled');
                        // Remove from canvas if disabled
                        if (this.removeCameraFromCanvas) {
                            this.removeCameraFromCanvas(camera);
                        }
                    }
                }
            }

            // Set up click handlers
            if (cameraContainer) {
                cameraContainer.onclick = null;
                cameraContainer.onclick = (e) => {
                    if (e.target !== toggle && !e.target.closest('input')) {
                        toggle.checked = !toggle.checked;
                        toggle.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                };
            }
        });

        // Add change event listeners for flexible layout
        cameraToggles.forEach(toggle => {
            // Remove existing listeners to avoid duplicates
            toggle.removeEventListener('change', this.handleCameraToggleChange);
            toggle.addEventListener('change', this.handleCameraToggleChange.bind(this));
        });
    }

    handleCameraToggleChange(e) {
        const cameraContainer = e.target.closest('.camera-item') || e.target.closest('.camera-slot');
        const camera = cameraContainer?.dataset.camera;

        if (camera && this.cameraLayout) {
            if (e.target.checked) {
                // Camera enabled - add to default position if not already positioned
                cameraContainer.classList.remove('disabled');
                if (!this.cameraLayout.positions.has(camera)) {
                    this.addCameraToDefaultPosition(camera);
                }
            } else {
                // Camera disabled - remove from canvas
                this.removeCameraFromCanvas(camera);
                cameraContainer.classList.add('disabled');
            }

            // Update export estimates
            this.updateExportEstimates();
        }
    }

    addCameraToDefaultPosition(camera) {
        // Find a good default position for newly enabled cameras using the same grid as initialization
        const canvas = document.getElementById('camera-layout-canvas');
        if (!canvas) return;

        // Use the same seamless 3x2 grid positions as initialization
        const cameraWidth = 100;  // Width of each camera
        const cameraHeight = 60;  // Height of each camera
        const startX = 20;        // Starting X position
        const startY = 20;        // Starting Y position

        const defaultPositions = {
            'left_pillar': { x: startX, y: startY },                           // Top row, left
            'front': { x: startX + cameraWidth, y: startY },                   // Top row, center (no gap)
            'right_pillar': { x: startX + (cameraWidth * 2), y: startY },      // Top row, right (no gap)
            'left_repeater': { x: startX, y: startY + cameraHeight },          // Bottom row, left (no gap)
            'back': { x: startX + cameraWidth, y: startY + cameraHeight },     // Bottom row, center (no gap)
            'right_repeater': { x: startX + (cameraWidth * 2), y: startY + cameraHeight } // Bottom row, right (no gap)
        };

        // Use the predefined position for this camera
        const position = defaultPositions[camera];
        if (position) {
            this.positionCameraOnCanvas(camera, position.x, position.y);
            console.log(`🎬 Added ${camera} to default position (${position.x}, ${position.y})`);
        } else {
            // Fallback: find an empty spot using the existing algorithm
            const existingCameras = canvas.querySelectorAll('.camera-item.positioned');
            const positions = Array.from(existingCameras).map(item => ({
                x: parseInt(item.style.left) || 0,
                y: parseInt(item.style.top) || 0
            }));

            // Use consistent spacing: 140px horizontal, 100px vertical
            const horizontalSpacing = 140;
            const verticalSpacing = 100;
            let found = false;
            let x = 20, y = 20;

            for (let row = 0; row < 3 && !found; row++) {
                for (let col = 0; col < 3 && !found; col++) {
                    const testX = col * horizontalSpacing + 20;
                    const testY = row * verticalSpacing + 20;

                    const occupied = positions.some(pos =>
                        Math.abs(pos.x - testX) < 60 && Math.abs(pos.y - testY) < 50
                    );

                    if (!occupied) {
                        x = testX;
                        y = testY;
                        found = true;
                    }
                }
            }

            this.positionCameraOnCanvas(camera, x, y);
            console.log(`🎬 Added ${camera} to fallback position (${x}, ${y})`);
        }
    }

    async detectHardwareAcceleration() {
        const hwaccelCheckbox = document.getElementById('hwaccel-enabled');
        const hwaccelStatus = document.getElementById('hwaccel-status');
        const hwaccelDescription = document.getElementById('hwaccel-description');
        const hwaccelOption = document.querySelector('.hwaccel-option');
        const hwaccelSpinner = document.getElementById('hwaccel-spinner');

        if (!hwaccelCheckbox || !hwaccelStatus || !hwaccelDescription || !hwaccelSpinner) return;

        try {
            // Show detecting status with spinner
            hwaccelSpinner.classList.remove('hidden');
            hwaccelStatus.textContent = 'Detecting GPU...';
            hwaccelDescription.textContent = 'Testing hardware acceleration capabilities';
            hwaccelCheckbox.disabled = true;
            hwaccelOption.classList.add('disabled');

            // Call main process to detect hardware acceleration
            const hwAccel = await window.electronAPI.invoke('tesla:detect-hwaccel');

            // Hide spinner when detection completes
            hwaccelSpinner.classList.add('hidden');

            if (hwAccel.available) {
                // Hardware acceleration available
                hwaccelStatus.textContent = `${hwAccel.type} Detected`;
                hwaccelStatus.className = 'gpu-detected';
                hwaccelDescription.textContent = `Hardware acceleration available (${hwAccel.encoder})`;
                hwaccelCheckbox.disabled = false;
                hwaccelOption.classList.remove('disabled');
                hwaccelCheckbox.title = '';
                // Store hardware acceleration info for export
                this.hardwareAcceleration = hwAccel;
                console.log(`🚀 Hardware acceleration available: ${hwAccel.type}`);

                // Add event listener for hardware acceleration toggle
                hwaccelCheckbox.addEventListener('change', () => {
                    this.updateTimelapsePreview();
                    this.updateExportEstimates();
                });
            } else {
                // No hardware acceleration
                hwaccelStatus.textContent = 'No GPU Detected';
                hwaccelStatus.className = 'gpu-not-detected';
                hwaccelDescription.textContent = 'Hardware acceleration not available - will use CPU encoding';
                hwaccelCheckbox.disabled = true;
                hwaccelCheckbox.checked = false;
                hwaccelOption.classList.add('disabled');
                hwaccelCheckbox.title = '';
                this.hardwareAcceleration = null;
                console.log('⚠️ No hardware acceleration available');
            }
        } catch (error) {
            console.error('Error detecting hardware acceleration:', error);
            // Hide spinner on error
            hwaccelSpinner.classList.add('hidden');
            hwaccelStatus.textContent = 'Detection Failed';
            hwaccelStatus.className = 'gpu-not-detected';
            hwaccelDescription.textContent = 'Could not detect hardware acceleration capabilities';
            hwaccelCheckbox.disabled = true;
            hwaccelCheckbox.checked = false;
            hwaccelOption.classList.add('disabled');
            this.hardwareAcceleration = null;
        }
    }

    // Unified file size calculation used by all export estimates
    calculateExportFileSize(durationSeconds, selectedCameras, quality, isTimelapse = false, timelapseSpeed = 1) {
        // Base size per minute calibrated from actual export results
        // Your 59-minute export → 59-second timelapse = 700.6 MB
        // This gives us ~715 MB per minute of OUTPUT video for 6 cameras mobile
        let baseSizePerMinute;

        if (isTimelapse && timelapseSpeed > 1) {
            // For timelapse OUTPUT duration calculation
            // Based on actual result: 59 seconds output = 700.6 MB
            if (quality === 'full') {
                // Full quality timelapse: higher bitrate
                baseSizePerMinute = selectedCameras <= 2 ? 400 :
                                   selectedCameras <= 4 ? 600 :
                                   selectedCameras <= 6 ? 1000 : 1200; // MB per minute of OUTPUT
            } else {
                // Mobile quality timelapse: calibrated from your actual result
                baseSizePerMinute = selectedCameras <= 2 ? 250 :
                                   selectedCameras <= 4 ? 450 :
                                   selectedCameras <= 6 ? 715 : 850; // 715 MB/min output matches your 700.6MB result
            }

            // Calculate based on OUTPUT duration
            const outputDurationMinutes = durationSeconds / timelapseSpeed / 60;
            return Math.round(outputDurationMinutes * baseSizePerMinute);
        } else {
            // Regular (non-timelapse) export calculation
            if (quality === 'full') {
                // Full quality: higher bitrate
                baseSizePerMinute = selectedCameras <= 2 ? 60 :
                                   selectedCameras <= 4 ? 120 :
                                   selectedCameras <= 6 ? 180 : 220;
            } else {
                // Mobile quality: much lower for regular exports
                baseSizePerMinute = selectedCameras <= 2 ? 25 :
                                   selectedCameras <= 4 ? 45 :
                                   selectedCameras <= 6 ? 70 : 90;
            }

            // Calculate based on INPUT duration
            const inputDurationMinutes = durationSeconds / 60;

            // Duration factor: longer videos compress slightly better
            const durationFactor = inputDurationMinutes < 1 ? 1.1 :
                                  inputDurationMinutes < 5 ? 1.0 :
                                  inputDurationMinutes < 15 ? 0.95 : 0.9;

            return Math.round(inputDurationMinutes * baseSizePerMinute * durationFactor);
        }
    }

    updateTimelapsePreview() {
        const timelapseEnabled = document.getElementById('timelapse-enabled')?.checked;
        const timelapseSpeed = document.getElementById('timelapse-speed')?.value;
        const previewText = document.getElementById('timelapse-preview-text');

        if (!previewText) return;

        if (!timelapseEnabled) {
            previewText.textContent = 'Enable timelapse to see preview calculations';
            previewText.className = 'timelapse-preview-text';
            return;
        }

        // Get current export duration
        const startTime = this.exportStartTime || 0;
        const endTime = this.exportEndTime || (this.currentTimeline?.totalDuration || 0);
        const exportDurationMs = endTime - startTime;

        if (!timelapseSpeed || exportDurationMs <= 0) {
            previewText.textContent = 'Select export range to see timelapse preview';
            previewText.className = 'timelapse-preview-text warning';
            return;
        }

        const speedMultiplier = parseInt(timelapseSpeed);
        const exportDurationSeconds = exportDurationMs / 1000;
        const timelapseOutputSeconds = exportDurationSeconds / speedMultiplier;

        // Get current settings
        const selectedCameras = Array.from(document.querySelectorAll('.camera-export-toggle:checked')).length;
        const quality = document.querySelector('input[name="export-quality"]:checked')?.value || 'mobile';

        // Use unified calculation
        const estimatedSizeMB = this.calculateExportFileSize(exportDurationSeconds, selectedCameras, quality, true, speedMultiplier);

        // Calculate processing time estimate
        const hwaccelEnabled = document.getElementById('hwaccel-enabled')?.checked || false;
        const processingMultiplier = hwaccelEnabled ? 0.3 : 0.8; // Hardware acceleration is much faster
        const estimatedProcessingMinutes = Math.round(exportDurationSeconds / 60 * processingMultiplier);

        // Format durations
        const inputDuration = this.formatDuration(exportDurationSeconds);
        const outputDuration = this.formatDuration(timelapseOutputSeconds);
        const processingTime = this.formatDuration(estimatedProcessingMinutes * 60);

        // Format quality text
        const qualityText = quality === 'full' ? 'Full Resolution' : 'Mobile Quality';

        // Create comprehensive preview
        const preview = [
            `📹 Input: ${inputDuration} → Output: ${outputDuration} (${speedMultiplier}x speed)`,
            `📁 Estimated size: ${estimatedSizeMB}MB (${selectedCameras} cameras, ${qualityText})`,
            `⏱️ Processing time: ~${processingTime}${hwaccelEnabled ? ' (HW Accelerated)' : ''}`
        ].join('\n');

        previewText.textContent = preview;
        previewText.className = 'timelapse-preview-text success';
    }

    formatDuration(seconds) {
        if (seconds < 60) {
            return `${Math.round(seconds)}s`;
        } else if (seconds < 3600) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.round(seconds % 60);
            return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const mins = Math.round((seconds % 3600) / 60);
            return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
    }

    updateExportEstimates() {
        const fileSizeElement = document.getElementById('estimated-file-size');
        const durationElement = document.getElementById('export-duration-estimate');

        if (!fileSizeElement || !durationElement || !this.currentTimeline) return;

        // Get selected quality
        const qualityInput = document.querySelector('input[name="export-quality"]:checked');
        const quality = qualityInput?.value || 'full';

        // Get selected cameras
        const selectedCameras = Array.from(document.querySelectorAll('.camera-export-toggle:checked')).length;

        // Calculate export duration using sync-adjusted range and gap-aware calculation
        const { startTime, endTime } = this.getSyncAdjustedExportRange();
        let exportDuration = this.calculateActualFootageDuration(startTime, endTime);

        // Check if timelapse is enabled
        const timelapseEnabled = document.getElementById('timelapse-enabled')?.checked || false;
        const timelapseSpeed = parseInt(document.getElementById('timelapse-speed')?.value || '60');

        // Use unified calculation
        const estimatedSize = this.calculateExportFileSize(exportDuration, selectedCameras, quality, timelapseEnabled, timelapseSpeed);

        if (timelapseEnabled && timelapseSpeed > 1) {
            const finalDuration = Math.round(exportDuration / timelapseSpeed);
            console.log(`📊 Timelapse estimates: ${exportDuration}s → ${finalDuration}s (${timelapseSpeed}x speed)`);
        }

        // Estimate processing time with hardware acceleration consideration
        const hwAccelMultiplier = this.hardwareAcceleration ? 0.3 : 0.8; // Hardware acceleration is much faster
        const baseProcessingTime = exportDuration * hwAccelMultiplier;
        const processingTime = timelapseEnabled ?
            Math.round(baseProcessingTime * 1.1) : // Timelapse adds 10% processing time
            Math.round(baseProcessingTime);

        fileSizeElement.textContent = `~${estimatedSize} MB`;
        durationElement.textContent = `~${this.formatDuration(Math.max(60, processingTime))}`;
    }

    async startVideoExport() {
        console.log('🚀 Debug: startVideoExport called');
        console.log('🔍 Debug: window.electronAPI at start:', window.electronAPI);

        if (!this.currentTimeline) {
            alert('No timeline loaded');
            return;
        }

        // Get export settings
        const qualityInput = document.querySelector('input[name="export-quality"]:checked');
        const quality = qualityInput?.value || 'full';

        // Use flexible camera layout system for camera selection
        const selectedCameras = this.getExportCameras();
        const cameraLayout = this.generateFFMPEGLayout();

        if (selectedCameras.length === 0) {
            alert('Please position at least one camera on the canvas to export');
            return;
        }

        if (!cameraLayout) {
            alert('Camera layout could not be generated. Please check your camera positions.');
            return;
        }

        console.log(`🎬 Exporting with flexible layout: ${selectedCameras.length} cameras`);
        console.log('🎬 Camera layout:', cameraLayout);

        const timestampEnabled = document.getElementById('timestamp-overlay-enabled')?.checked || false;
        const timestampPosition = document.getElementById('timestamp-position')?.value || 'bottom-center';

        // Calculate export range with sync adjustments
        const { startTime, endTime } = this.getSyncAdjustedExportRange();

        // Show progress section
        const progressSection = document.getElementById('export-progress');
        const startButton = document.getElementById('start-export');

        if (progressSection) progressSection.classList.remove('hidden');
        if (startButton) startButton.disabled = true;

        try {
            // Get hardware acceleration settings
            const hwaccelEnabled = document.getElementById('hwaccel-enabled')?.checked || false;
            const hwaccelData = hwaccelEnabled && this.hardwareAcceleration ? {
                enabled: true,
                type: this.hardwareAcceleration.type,
                encoder: this.hardwareAcceleration.encoder,
                decoder: this.hardwareAcceleration.decoder
            } : {
                enabled: false
            };

            // Get timelapse settings
            const timelapseEnabled = document.getElementById('timelapse-enabled')?.checked || false;
            const timelapseSpeed = document.getElementById('timelapse-speed')?.value || '60';
            const timelapseData = {
                enabled: timelapseEnabled,
                speed: timelapseSpeed
            };

            // Debug: Log timelapse settings
            console.log('🎬 Timelapse settings:', timelapseData);

            // Prepare export data with flexible camera layout
            const exportData = {
                timeline: this.currentTimeline,
                startTime,
                endTime,
                quality,
                cameras: selectedCameras,
                cameraLayout: cameraLayout, // Add flexible camera layout data
                timestamp: {
                    enabled: timestampEnabled,
                    position: timestampPosition
                },
                hwaccel: hwaccelData,
                timelapse: timelapseData
            };

            console.log('Starting video export with settings:', exportData);

            // Call backend export function
            await this.performVideoExport(exportData);

            // Export completed
            this.updateExportProgress(100, 'Export completed successfully!');

            // Re-enable the export button
            if (startButton) startButton.disabled = false;

            setTimeout(() => {
                this.closeExportDialog();
            }, 2000);

        } catch (error) {
            console.error('Export failed:', error);
            this.updateExportProgress(0, `Export failed: ${error.message}`);

            // Re-enable the export button on error too
            if (startButton) startButton.disabled = false;
        }
    }

    async performVideoExport(exportData) {
        try {
            // Debug: Check what's available
            const apiKeys = Object.keys(window.electronAPI || {});
            console.log('🔍 Debug: window.electronAPI keys:', apiKeys);
            console.log('🔍 Debug: Keys are:', apiKeys.join(', '));
            console.log('🔍 Debug: window.electronAPI:', window.electronAPI);
            console.log('🔍 Debug: window.electronAPI.dialog:', window.electronAPI?.dialog);
            console.log('🔍 Debug: window.electronAPI.dialog.saveFile:', window.electronAPI?.dialog?.saveFile);
            console.log('🔍 Debug: typeof window.electronAPI:', typeof window.electronAPI);

            if (!window.electronAPI) {
                throw new Error('electronAPI is not available');
            }
            if (!window.electronAPI.dialog) {
                // Try to add dialog API manually as a workaround
                console.log('🔧 Attempting to add dialog API manually...');
                if (window.electronAPI.invoke) {
                    window.electronAPI.dialog = {
                        saveFile: (options) => window.electronAPI.invoke('dialog:save-file', options)
                    };
                    console.log('✅ Dialog API added manually');
                } else {
                    throw new Error('electronAPI.dialog is not available and cannot be added manually');
                }
            }
            if (!window.electronAPI.dialog.saveFile) {
                throw new Error('electronAPI.dialog.saveFile is not available');
            }

            // Get save location from user
            const outputPath = await window.electronAPI.dialog.saveFile({
                title: 'Save Tesla Dashcam Export',
                defaultPath: `tesla_export_${new Date().toISOString().slice(0, 10)}.mp4`,
                filters: [
                    { name: 'Video Files', extensions: ['mp4'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (!outputPath) {
                throw new Error('Export cancelled by user');
            }

            // Add output path to export data
            exportData.outputPath = outputPath;

            // Generate unique export ID
            const exportId = `export_${Date.now()}`;
            this.currentExportId = exportId;

            // Set up progress listener
            const progressHandler = (event, receivedExportId, progress) => {
                if (receivedExportId === exportId) {
                    if (progress.type === 'progress') {
                        this.updateExportProgress(progress.percentage, progress.message);
                    } else if (progress.type === 'complete') {
                        if (progress.success) {
                            this.updateExportProgress(100, progress.message);

                            // Re-enable export button
                            const startButton = document.getElementById('start-export');
                            if (startButton) startButton.disabled = false;

                            // Show success message with option to open file location
                            setTimeout(() => {
                                const openLocation = confirm(`${progress.message}\n\nWould you like to open the file location?`);
                                if (openLocation) {
                                    window.electronAPI.fs.showItemInFolder(outputPath);
                                }
                                this.closeExportDialog();
                            }, 1000);
                        } else {
                            this.updateExportProgress(0, progress.message);
                            
                            // Re-enable export button on failure
                            const startButton = document.getElementById('start-export');
                            if (startButton) startButton.disabled = false;
                            
                            // alert(`Export failed: ${progress.message}`);
                        }

                        // Remove progress listener
                        window.electronAPI.removeListener('tesla:export-progress', progressHandler);
                    }
                }
            };

            // Add progress listener
            window.electronAPI.on('tesla:export-progress', progressHandler);

            // Start the export
            console.log('🚀 Starting Tesla video export with data:', exportData);
            const success = await window.electronAPI.tesla.exportVideo(exportId, exportData);

            if (!success) {
                throw new Error('Failed to start export process');
            }

        } catch (error) {
            console.error('💥 Export failed:', error);
            this.updateExportProgress(0, `Export failed: ${error.message}`);
            if (this.exportWasCancelled) {
                this.exportWasCancelled = false;
                return;
            }
            alert('Export failed. Please check your input files and try again. For more details, see the debug log.');
        }
    }

    updateExportProgress(percentage, status) {
        const progressFill = document.getElementById('progress-fill');
        const progressPercentage = document.getElementById('progress-percentage');
        const progressStatus = document.getElementById('progress-status');

        if (progressFill) progressFill.style.width = `${percentage}%`;
        if (progressPercentage) progressPercentage.textContent = `${percentage}%`;
        if (progressStatus) progressStatus.textContent = status;
    }

    renderTimelineGaps() {
        if (!this.currentTimeline) return;

        const timelineTrack = document.querySelector('.timeline-track');
        if (!timelineTrack) return;

        // Remove existing gap indicators
        timelineTrack.querySelectorAll('.gap-indicator, .gap-marker').forEach(el => el.remove());

        // Use accurate timeline gaps if available
        const gaps = this.currentTimeline.accurateTimeline && this.currentTimeline.timelineGaps ? 
            this.currentTimeline.timelineGaps : 
            (this.currentTimeline.gaps || []);

        // Gap markers and notifications removed for cleaner user experience
    }



    calculateSegmentPosition(clipIndex) {
        // Calculate position based on footage segments, not real time
        if (!this.currentTimeline.segments) return 0;

        let footagePosition = 0;
        for (let segment of this.currentTimeline.segments) {
            if (clipIndex <= segment.endIndex) {
                const positionInSegment = Math.max(0, clipIndex - segment.startIndex);
                const segmentFootage = (positionInSegment / (segment.endIndex - segment.startIndex + 1)) * segment.duration * 1000;
                footagePosition += segmentFootage;
                break;
            } else {
                footagePosition += segment.duration * 1000;
            }
        }

        return (footagePosition / this.currentTimeline.totalDuration) * 100;
    }



    updateTimelineInfo() {
        if (!this.currentTimeline) return;

        const timelineInfo = document.querySelector('.timeline-info');
        if (!timelineInfo) {
            console.warn('⚠️ Timeline info element not found');
            return;
        }

        let infoText = '';

        if (this.currentTimeline.accurateTimeline) {
            // Use accurate timeline information
            const totalClips = this.currentTimeline.clips.length;
            const gaps = this.currentTimeline.timelineGaps || [];
            const totalDuration = Math.round(this.currentTimeline.displayDuration / 1000);
            const startTime = new Date(this.currentTimeline.startTime).toLocaleTimeString();
            const endTime = new Date(this.currentTimeline.endTime).toLocaleTimeString();

            infoText = `${totalClips} clips • ${totalDuration}s • ${startTime} - ${endTime}`;
        } else {
            // Fallback to old method
            const segments = this.currentTimeline.segments || [];
            const gaps = this.currentTimeline.gaps || [];
            const coverage = this.currentTimeline.actualCoverage || 100;

            infoText = `${this.currentTimeline.clips.length} clips • ${segments.length} segments • ${coverage.toFixed(0)}% coverage`;
        }

        timelineInfo.textContent = infoText;
    }

    formatTimelineTime(totalSeconds) {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    updateTimestampDisplay() {
        const timestampDisplay = document.getElementById('timestamp-display');

        if (this.currentTimeline) {
            // Timeline mode - calculate timestamp based on current timeline position
            // Convert continuous position to actual position for accurate timestamp calculation
            const continuousPosition = this.currentTimeline.currentPosition;
            const actualPosition = this.continuousToActualPosition(continuousPosition);
            const currentTimestamp = this.calculateActualTimestamp(actualPosition);

            if (currentTimestamp) {
                const formatted = currentTimestamp.toLocaleString('en-US', {
                    month: '2-digit',
                    day: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                });

                timestampDisplay.textContent = formatted;
            } else {
                timestampDisplay.textContent = '--/--/---- --:--:-- --';
            }
        } else if (this.currentClipGroup) {
            // Single clip mode - use original logic
            const timestamp = new Date(this.currentClipGroup.timestamp);
            // Add current playback time to the base timestamp
            timestamp.setSeconds(timestamp.getSeconds() + this.currentTime);

            const formatted = timestamp.toLocaleString('en-US', {
                month: '2-digit',
                day: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });

            timestampDisplay.textContent = formatted;
        } else {
            timestampDisplay.textContent = '--/--/---- --:--:-- --';
        }
    }

    // Time Update Loop
    startTimeUpdateLoop() {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
        }

        this.timeUpdateInterval = setInterval(() => {
            if (this.isPlaying) {
                this.updateTimestampDisplay();
            }
        }, 100); // Update every 100ms for smooth display
    }

    stopTimeUpdateLoop() {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }

    // Utility Methods
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    calculateActualTimestamp(timelinePosition) {
        if (!this.currentTimeline || !this.currentTimeline.accurateTimeline) {
            return null;
        }

        const startTimestamp = new Date(this.currentTimeline.startTime);
        const targetTimestamp = new Date(startTimestamp.getTime() + timelinePosition);
        
        return targetTimestamp;
    }

    showLoadingScreen(message) {
        const loadingScreen = document.getElementById('loading-screen');
        const loadingMessage = document.getElementById('loading-message');

        if (message) {
            loadingMessage.textContent = message;
        }

        loadingScreen.classList.remove('hidden');
    }

    hideLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen');
        loadingScreen.classList.add('hidden');
    }

    showLoadingIndicator(show) {
        const loadingIndicator = document.getElementById('loading-indicator');

        if (show) {
            console.log('📤 Showing loading indicator');
            loadingIndicator.classList.remove('hidden');
        } else {
            console.log('📥 Hiding loading indicator');
            loadingIndicator.classList.add('hidden');
        }
    }

    setupScanProgressListener() {
        // Listen for scan progress events from our optimized folder scanning
        if (window.electronAPI && window.electronAPI.on) {
            try {
                // Progress updates during scanning
                window.electronAPI.on('scan-progress', (event, progressData) => {
                    console.log(`📊 Scan progress: ${progressData.folder} - Status: ${progressData.status} - ${progressData.filesFound} files (Total: ${progressData.totalFiles})`);
                    
                    // Update loading text with progress info
                    const loadingIndicator = document.getElementById('loading-indicator');
                    const loadingSpan = loadingIndicator?.querySelector('span');
                    if (loadingSpan) {
                        if (progressData.status === 'scanning') {
                            // Show when we START scanning a folder
                            loadingSpan.textContent = `Scanning ${progressData.folder}... (${progressData.totalFiles} files found so far)`;
                        } else if (progressData.status === 'completed') {
                            // Show completion briefly, but the next folder will update this
                            loadingSpan.textContent = `Scanned ${progressData.folder}: ${progressData.filesFound} files (Total: ${progressData.totalFiles})`;
                        }
                    }
                });

                // Scan completion event - this is crucial for hiding the loading indicator
                window.electronAPI.on('scan-complete', (event, completionData) => {
                    console.log(`🏁 Main folder scan complete:`, completionData);
                    
                    // Reset loading text back to default since we're not loading events upfront anymore
                    const loadingIndicator = document.getElementById('loading-indicator');
                    const loadingSpan = loadingIndicator?.querySelector('span');
                    if (loadingSpan) {
                        loadingSpan.textContent = 'Loading Tesla files...';
                    }
                    
                    // The loading indicator will be hidden by the selectTeslaFolder finally block
                    // Events will be loaded on-demand when user clicks on dates
                    console.log('📥 Main scan complete - ready for user interaction!');
                });

                // Cache completion event - cache is written after everything is done
                window.electronAPI.on('cache-complete', (event, cacheData) => {
                    console.log(`💾 Cache write complete:`, cacheData);
                    console.log('✅ All folder loading and caching operations finished!');
                });

                console.log('✅ Scan progress and completion listeners set up successfully');
            } catch (error) {
                console.warn('⚠️ Could not set up scan listeners:', error);
            }
        } else {
            console.warn('⚠️ electronAPI.on not available for scan listeners');
        }
    }

    showError(title, message) {
        // Simple error display - could be enhanced with a modal
        console.error(`${title}: ${message}`);
        alert(`${title}\n\n${message}`);
    }

    showStatus(message) {
        console.log('[Status]', message);
        // Could update a status bar in the UI
        const timestampDisplay = document.getElementById('timestamp-display');
        if (timestampDisplay) {
            timestampDisplay.textContent = message;
            setTimeout(() => {
                this.updateTimestampDisplay();
            }, 3000);
        }
    }

    // Keyboard Shortcuts
    handleKeyboardShortcuts(event) {
        // Space or Enter: Play/Pause
        if (event.code === 'Space' || event.code === 'Enter') {
            event.preventDefault();
            this.togglePlayPause();
            this.showStatus('Play/Pause');
        }
        // Shift+Left: Skip Back 15s
        else if (event.code === 'ArrowLeft' && event.shiftKey) {
            event.preventDefault();
            this.skipSeconds(-15);
            this.showStatus('⏪ Skip Back 15s');
        }
        // Shift+Right: Skip Forward 15s
        else if (event.code === 'ArrowRight' && event.shiftKey) {
            event.preventDefault();
            this.skipSeconds(15);
            this.showStatus('⏩ Skip Forward 15s');
        }
        // Left: Frame Back
        else if (event.code === 'ArrowLeft') {
            event.preventDefault();
            this.frameStep(-1);
            this.showStatus('⬅️ Frame Back');
        }
        // Right: Frame Forward
        else if (event.code === 'ArrowRight') {
            event.preventDefault();
            this.frameStep(1);
            this.showStatus('➡️ Frame Forward');
        }
        // Up: Increase speed
        else if (event.code === 'ArrowUp') {
            event.preventDefault();
            this.adjustPlaybackSpeed(1);
        }
        // Down: Decrease speed
        else if (event.code === 'ArrowDown') {
            event.preventDefault();
            this.adjustPlaybackSpeed(-1);
        }
        // R: Reset all camera zoom levels
        else if (event.code === 'KeyR' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            this.resetAllCameraZoom();
            this.showStatus('🔍 Camera zoom reset');
        }
    }

    adjustPlaybackSpeed(direction) {
        const speedSelect = document.getElementById('speed-select');
        if (!speedSelect) return;
        const options = Array.from(speedSelect.options);
        const currentIdx = options.findIndex(opt => opt.selected);
        let newIdx = currentIdx + direction;
        newIdx = Math.max(0, Math.min(newIdx, options.length - 1));
        if (newIdx !== currentIdx) {
            options[newIdx].selected = true;
            speedSelect.dispatchEvent(new Event('change'));
            this.showStatus(`Speed: ${options[newIdx].text}`);
        }
    }

    // Settings
    openSettings() {
        const settingsModal = document.getElementById('settings-modal');
        const zeroProbeToggle = document.getElementById('zero-probe-toggle');
        if (zeroProbeToggle) zeroProbeToggle.checked = !!this.config.zeroProbeOnLoad;
        if (settingsModal) settingsModal.classList.remove('hidden');
    }
    // Test function for debugging timeline positioning
    testTimelinePositioning() {
        if (!this.currentTimeline) {
            console.log('❌ No timeline loaded. Load a date first.');
            return;
        }

        console.log('🧪 Testing Timeline Positioning:');
        console.log(`Timeline has ${this.currentTimeline.clips.length} clips`);
        console.log(`Timeline has ${this.currentTimeline.segments.length} segments`);
        console.log(`Timeline has ${this.currentTimeline.gaps.length} gaps`);
        console.log(`Total duration: ${Math.round(this.currentTimeline.totalDuration / 60000)} minutes`);

        // Test footage position calculation for each clip
        this.currentTimeline.clips.forEach((clip, index) => {
            const footagePos = this.calculateFootagePosition(index, 0);
            const timestamp = new Date(clip.timestamp).toLocaleTimeString();
            console.log(`Clip ${index}: ${timestamp} -> Footage position: ${Math.round(footagePos / 1000)}s`);
        });

        // Test what happens when we advance through clips
        console.log('\n🎬 Simulating playback advancement:');
        for (let i = 0; i < Math.min(5, this.currentTimeline.clips.length - 1); i++) {
            const currentClip = this.currentTimeline.clips[i];
            const nextClip = this.currentTimeline.clips[i + 1];
            const currentTime = new Date(currentClip.timestamp);
            const nextTime = new Date(nextClip.timestamp);
            const gap = (nextTime - currentTime) / 1000 - 60;

            const currentFootagePos = this.calculateFootagePosition(i, 60000); // End of current clip
            const nextFootagePos = this.calculateFootagePosition(i + 1, 0); // Start of next clip

            console.log(`${currentTime.toLocaleTimeString()} (${Math.round(currentFootagePos / 1000)}s) -> ${nextTime.toLocaleTimeString()} (${Math.round(nextFootagePos / 1000)}s)`);
            if (gap > 120) {
                console.log(`  📍 Gap: ${Math.round(gap / 60)} minutes - but footage position advances continuously`);
            }
        }
    }

    // Camera Visibility Methods
    toggleCameraPanel() {
        const panel = document.getElementById('camera-visibility-panel');
        panel.classList.toggle('hidden');
    }

    hideCameraPanel() {
        const panel = document.getElementById('camera-visibility-panel');
        panel.classList.add('hidden');
    }

    toggleCameraVisibility(camera, isVisible) {
        this.cameraVisibility[camera] = isVisible;
        const container = document.querySelector(`[data-camera="${camera}"]`);

        if (container) {
            if (isVisible) {
                container.classList.remove('hidden-camera');
            } else {
                container.classList.add('hidden-camera');
            }
        }

        console.log(`Camera ${camera} ${isVisible ? 'shown' : 'hidden'}`);
        this.updateVideoGridLayout();
    }

    showAllCameras() {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        cameras.forEach(camera => {
            this.cameraVisibility[camera] = true;
            const toggle = document.getElementById(`toggle-${camera}`);
            const container = document.querySelector(`[data-camera="${camera}"]`);

            if (toggle) toggle.checked = true;
            if (container) container.classList.remove('hidden-camera');
        });

        console.log('All cameras shown');
        this.updateVideoGridLayout();
    }

    hideAllCameras() {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        cameras.forEach(camera => {
            this.cameraVisibility[camera] = false;
            const toggle = document.getElementById(`toggle-${camera}`);
            const container = document.querySelector(`[data-camera="${camera}"]`);

            if (toggle) toggle.checked = false;
            if (container) container.classList.add('hidden-camera');
        });

        console.log('All cameras hidden');
        this.updateVideoGridLayout();
    }

    updateVideoGridLayout() {
        const videoGrid = document.getElementById('video-grid');
        const visibleCameras = Object.values(this.cameraVisibility).filter(visible => visible).length;

        // Adjust grid layout based on number of visible cameras
        if (visibleCameras === 1) {
            videoGrid.style.gridTemplateColumns = '1fr';
            videoGrid.style.gridTemplateRows = '1fr';
        } else if (visibleCameras === 2) {
            videoGrid.style.gridTemplateColumns = '1fr 1fr';
            videoGrid.style.gridTemplateRows = '1fr';
        } else if (visibleCameras === 3) {
            videoGrid.style.gridTemplateColumns = '1fr 1fr 1fr';
            videoGrid.style.gridTemplateRows = '1fr';
        } else if (visibleCameras === 4) {
            videoGrid.style.gridTemplateColumns = '1fr 1fr';
            videoGrid.style.gridTemplateRows = '1fr 1fr';
            // Ensure grid fits properly in available space
            videoGrid.style.height = '100%';
            videoGrid.style.maxHeight = 'calc(100vh - 180px)'; // Account for header + timeline
        } else if (visibleCameras === 5) {
            videoGrid.style.gridTemplateColumns = '1fr 1fr 1fr';
            videoGrid.style.gridTemplateRows = '1fr 1fr';
        } else {
            // Default 6-camera layout
            videoGrid.style.gridTemplateColumns = '1fr 1fr 1fr';
            videoGrid.style.gridTemplateRows = '1fr 1fr';
            videoGrid.style.height = '';
            videoGrid.style.maxHeight = '';
        }

        console.log(`Grid layout updated for ${visibleCameras} visible cameras`);
    }

    handleCorruptedClip(clipIndex) {
        console.warn(`🚨 Handling corrupted clip ${clipIndex + 1}`);

        // Release auto-advancement lock immediately
        this.isAutoAdvancing = false;

        // Mark clip as corrupted in timeline
        if (this.currentTimeline) {
            this.currentTimeline.actualDurations[clipIndex] = 0;
            
            // Update timeline duration
            if (this.currentTimeline.accurateTimeline) {
                this.updateAccurateTimelineDuration();
            } else {
                this.updateDynamicTimelineDuration();
            }
        }

        // Check if this clip has a very short estimated duration from timestamp analysis
        if (this.currentTimeline && this.currentTimeline.accurateTimeline) {
            const clip = this.currentTimeline.sortedClips[clipIndex];
            if (clip && clip.duration < 10) {
                console.warn(`⚠️ Clip ${clipIndex + 1} has very short estimated duration (${clip.duration}s) - likely corrupted`);
                this.showStatus(`Clip ${clipIndex + 1} appears to be corrupted (${clip.duration}s) and will be skipped`);
            } else {
                this.showStatus(`Clip ${clipIndex + 1} appears to be corrupted and will be skipped`);
            }
        } else {
            this.showStatus(`Clip ${clipIndex + 1} appears to be corrupted and will be skipped`);
        }

        // Skip to next clip if available
        if (this.currentTimeline && clipIndex < this.currentTimeline.clips.length - 1) {
            console.log(`⏭️ Skipping corrupted clip ${clipIndex + 1}, advancing to clip ${clipIndex + 2}`);

            // Small delay to ensure videos have stopped
            setTimeout(() => {
                this.loadTimelineClip(clipIndex + 1);

                // Start playing the next clip
                setTimeout(() => {
                    this.playAllVideos();
                }, 200);
            }, 100);
        } else {
            console.log(`🏁 Corrupted clip ${clipIndex + 1} was the last clip, ending timeline`);
            this.pauseAllVideos();
        }
    }

    checkOnboarding() {
        const onboardingNeverShow = localStorage.getItem('onboardingNeverShow');
        const onboardingShown = localStorage.getItem('onboardingShown');
        const lastFolder = localStorage.getItem('teslaFolder');
        const onboardingModal = document.getElementById('onboarding-modal');
        // Dark mode support
        if (document.body.classList.contains('dark')) {
            onboardingModal.classList.add('dark');
        } else {
            onboardingModal.classList.remove('dark');
        }
        if (onboardingNeverShow === 'true') {
            onboardingModal.classList.add('hidden');
            return;
        }
        // Show onboarding if not suppressed
        if (!onboardingShown || !lastFolder) {
            onboardingModal.classList.remove('hidden');
            // Wire up modal buttons
            document.getElementById('onboarding-select-folder').onclick = () => {
                const dontShow = document.getElementById('onboarding-dont-show').checked;
                if (dontShow) {
                    localStorage.setItem('onboardingNeverShow', 'true');
                } else {
                    localStorage.removeItem('onboardingNeverShow');
                }
                // Show spinner and disable button
                const btn = document.getElementById('onboarding-select-folder');
                const spinner = document.getElementById('onboarding-folder-spinner');
                if (btn) btn.disabled = true;
                if (spinner) spinner.style.display = '';
                this.selectTeslaFolder(true, dontShow).finally(() => {
                    if (btn) btn.disabled = false;
                    if (spinner) spinner.style.display = 'none';
                });
            };
            document.getElementById('close-onboarding-modal').onclick = () => {
                const dontShow = document.getElementById('onboarding-dont-show').checked;
                if (dontShow) {
                    // Persistently suppress onboarding when user explicitly opts out
                    localStorage.setItem('onboardingNeverShow', 'true');
                    localStorage.setItem('onboardingShown', 'true');
                } else {
                    // Ensure onboarding can appear again next launch
                    localStorage.removeItem('onboardingNeverShow');
                    localStorage.removeItem('onboardingShown');
                }
                onboardingModal.classList.add('hidden');
            };
        } else {
            onboardingModal.classList.add('hidden');
        }
    }

    frameStep(direction) {
        if (this.currentTimeline) {
            // Timeline mode - use Tesla's actual frame rate (36.02 FPS)
            const teslaFps = 36.02;
            const frameDurationMs = 1000.0 / teslaFps; // ≈ 27.8ms per frame
            const offsetMs = direction * frameDurationMs;

            // Calculate new global position
            const currentGlobalMs = this.currentTimeline.currentPosition;
            const newGlobalMs = Math.max(0, Math.min(currentGlobalMs + offsetMs, this.currentTimeline.displayDuration));

            console.log(`🎯 Frame step ${direction > 0 ? 'forward' : 'back'}: ${currentGlobalMs.toFixed(1)}ms -> ${newGlobalMs.toFixed(1)}ms`);

            // Seek to new position
            this.seekToGlobalPosition(newGlobalMs);

            // Pause after frame step
            this.pauseAllVideos();
        } else {
            // Single clip mode - use original logic
            const frameDuration = 1 / 36.0;
            Object.values(this.videos).forEach(video => {
                if (video && !isNaN(video.duration)) {
                    let newTime = video.currentTime + direction * frameDuration;
                    newTime = Math.max(0, Math.min(newTime, video.duration));
                    video.currentTime = newTime;
                }
            });
            this.pauseAllVideos();
        }
    }

    skipSeconds(seconds) {
        if (this.currentTimeline) {
            // Timeline mode - seek across clips properly
            const offsetMs = seconds * 1000; // Convert seconds to milliseconds
            const currentGlobalMs = this.currentTimeline.currentPosition;
            const newGlobalMs = Math.max(0, Math.min(currentGlobalMs + offsetMs, this.currentTimeline.displayDuration));

            console.log(`🎯 Skip ${seconds}s: ${Math.round(currentGlobalMs/1000)}s -> ${Math.round(newGlobalMs/1000)}s`);

            // Seek to new position
            this.seekToGlobalPosition(newGlobalMs);
        } else {
            // Single clip mode - use original logic
            Object.values(this.videos).forEach(video => {
                if (video && !isNaN(video.duration)) {
                    let newTime = video.currentTime + seconds;
                    newTime = Math.max(0, Math.min(newTime, video.duration));
                    video.currentTime = newTime;
                }
            });
        }
    }

    // ===== EVENT MARKER SYSTEM =====

    setupEventMarkers() {
        console.log('Setting up event marker system...');

        // Create event tooltip element
        this.createEventTooltip();

        // Initialize empty event markers array
        this.eventMarkers = [];

        console.log('Event marker system initialized');
    }

    createEventTooltip() {
        // Remove existing tooltip if any
        const existingTooltip = document.getElementById('event-tooltip');
        if (existingTooltip) {
            existingTooltip.remove();
        }

        // Create tooltip element
        this.eventTooltip = document.createElement('div');
        this.eventTooltip.id = 'event-tooltip';
        this.eventTooltip.className = 'event-tooltip hidden';
        this.eventTooltip.innerHTML = `
            <div class="event-tooltip-content">
                <div class="event-tooltip-image">
                    <img id="event-tooltip-img" src="" alt="Event thumbnail">
                </div>
                <div class="event-tooltip-info">
                    <div class="event-tooltip-reason" id="event-tooltip-reason"></div>
                    <div class="event-tooltip-time" id="event-tooltip-time"></div>
                    <div class="event-tooltip-location" id="event-tooltip-location"></div>
                </div>
            </div>
        `;

        document.body.appendChild(this.eventTooltip);
    }

    async loadEventMarkers(folderPath) {
        console.log('Loading event markers for:', folderPath);

        try {
            // Get event data from main process (legacy method - loads all events)
            const events = await window.electronAPI.tesla.getEventData(folderPath);
            console.log(`Found ${events.length} events`);

            // Clear existing markers
            this.clearEventMarkers();

            // Process events and create markers
            this.eventMarkers = events.map(event => this.createEventMarkerData(event));

            // Render markers on timeline
            this.renderEventMarkers();

            console.log(`Loaded ${this.eventMarkers.length} event markers`);

        } catch (error) {
            console.error('Error loading event markers:', error);
        }
    }

    async loadEventMarkersForDate(targetDate, sectionName) {
        try {
            // Get the folder path from localStorage (saved during folder selection)
            const folderPath = localStorage.getItem('teslaFolder');
            if (!folderPath) {
                console.warn('No folder path found for event loading');
                return;
            }

            // Always reload events from backend to ensure we get the latest data
            // This prevents issues with stale cache data
            const events = await window.electronAPI.tesla.getEventsForDate(folderPath, targetDate, sectionName);

            // Process events and create markers
            const eventMarkers = events.map(event => this.createEventMarkerData(event));

            // Cache the results
            if (!this.eventMarkersCache) {
                this.eventMarkersCache = {};
            }
            const cacheKey = `${sectionName}-${targetDate}`;
            this.eventMarkersCache[cacheKey] = eventMarkers;

            // Set markers for current timeline
            this.setEventMarkersForCurrentTimeline(eventMarkers);

            console.log(`📍 Loaded ${eventMarkers.length} event markers for ${targetDate}`);

        } catch (error) {
            console.error(`Error loading event markers for ${targetDate}:`, error);
        }
    }

    setEventMarkersForCurrentTimeline(eventMarkers) {
        // Clear existing markers from display
        this.clearEventMarkers();

        // Reset the rendered flag to allow re-rendering for new date
        if (this.currentTimeline) {
            this.currentTimeline.eventMarkersRendered = false;
        }

        // Set the markers for the current timeline only
        this.eventMarkers = eventMarkers;

        // Render markers on timeline
        this.renderEventMarkers();
    }

    createEventMarkerData(event) {
        // Determine marker type and emoji based on reason
        let type = 'default';
        let emoji = '🔔'; // Default bell emoji

        if (event.reason.toLowerCase().includes('sentry')) {
            type = 'sentry';
            emoji = '❗'; // Red exclamation mark for sentry events
        } else if (event.reason.toLowerCase().includes('user_interaction')) {
            type = 'user_interaction';
            // Check for specific user interaction types
            if (event.reason.toLowerCase().includes('honk')) {
                emoji = '🔊'; // Loudspeaker for honk events
            } else {
                emoji = '👆'; // Pointing hand for dashcam button press and other user interactions
            }
        }

        return {
            id: `event-${Date.now()}-${Math.random()}`,
            timestamp: new Date(event.timestamp),
            reason: event.reason,
            type: type,
            emoji: emoji,
            thumbnailPath: event.thumbnailPath,
            folderPath: event.folderPath,
            city: event.city,
            folderType: event.type, // Preserve the original folder type (SentryClips/SavedClips)
            position: 0 // Will be calculated when timeline is loaded
        };
    }

    renderEventMarkers() {
        if (!this.currentTimeline || this.eventMarkers.length === 0) {
            return;
        }

        // Allow initial render but prevent re-rendering during timeline updates
        if (this.isUpdatingTimeline && this.currentTimeline.eventMarkersRendered) {
            return;
        }

        const timelineMarkers = document.getElementById('timeline-markers');
        if (!timelineMarkers) {
            console.warn('Timeline markers container not found');
            return;
        }

        // Clear existing event markers
        const existingEventMarkers = timelineMarkers.querySelectorAll('.event-marker');
        existingEventMarkers.forEach(marker => marker.remove());

        // Use accurate timeline positioning if available
        if (this.currentTimeline.accurateTimeline) {
            this.renderAccurateEventMarkers(timelineMarkers);
        } else {
            // Fallback to old method for legacy timelines
            this.renderLegacyEventMarkers(timelineMarkers);
        }

        // Mark that event markers have been rendered
        this.currentTimeline.eventMarkersRendered = true;
    }

    renderAccurateEventMarkers(timelineMarkers) {
        // Calculate timeline bounds using actual timeline (including gaps)
        const timelineStart = new Date(this.currentTimeline.startTime).getTime();
        const timelineEnd = new Date(this.currentTimeline.endTime).getTime();
        const actualTimelineDuration = timelineEnd - timelineStart;

        // Get the selected date and section for filtering events
        const selectedDate = this.currentTimeline.date;
        const selectedSection = this.currentTimeline.sectionName;
        const selectedDateObj = new Date(selectedDate);
        const selectedDateStart = new Date(selectedDateObj.getFullYear(), selectedDateObj.getMonth(), selectedDateObj.getDate()).getTime();
        const selectedDateEnd = selectedDateStart + (24 * 60 * 60 * 1000); // End of the selected date

        // Filter events by the selected date, section type, AND timeline bounds
        const visibleEvents = this.eventMarkers.filter((eventMarker, index) => {
            const eventTime = eventMarker.timestamp.getTime();
            const eventDate = eventMarker.timestamp.getTime();
            
            // Check if event is from the selected date
            const isFromSelectedDate = eventDate >= selectedDateStart && eventDate < selectedDateEnd;
            
            // Check if event is from the correct section type
            const isFromCorrectSection = this.isEventFromSection(eventMarker, selectedSection);
            
            // Check if event is within or after the timeline (for positioning at end)
            const isWithinTimeline = eventTime >= timelineStart;
            
            return isFromSelectedDate && isFromCorrectSection && isWithinTimeline;
        });

        // Create and position event markers using continuous timeline positioning
        visibleEvents.forEach((eventMarker, index) => {
            const eventTime = eventMarker.timestamp.getTime();
            let actualRelativePosition = eventTime - timelineStart;
            
            // If event is after timeline ends, position it at the very end
            if (eventTime > timelineEnd) {
                actualRelativePosition = actualTimelineDuration;
                console.log(`⚠️ Event after timeline end: ${eventMarker.reason} at ${eventMarker.timestamp.toLocaleTimeString()}, positioning at timeline end`);
            }
            
            // Convert actual position to continuous position for visual alignment with timeline scrubber
            const continuousPosition = this.actualToContinuousPosition(actualRelativePosition);
            const percentage = Math.max(0, Math.min(100, (continuousPosition / this.currentTimeline.displayDuration) * 100));

            // Update marker position
            eventMarker.position = percentage;

            // Only create marker if it's within visible range
            if (percentage >= 0 && percentage <= 100) {
                const markerElement = this.createEventMarkerElement(eventMarker);
                timelineMarkers.appendChild(markerElement);
                
                console.log(`📍 Event marker positioned at ${percentage.toFixed(1)}%: ${eventMarker.reason} at ${eventMarker.timestamp.toLocaleTimeString()}`);
            }
        });

        console.log(`✅ Rendered ${visibleEvents.length} event markers on accurate timeline`);
    }

    isEventFromSection(eventMarker, selectedSection) {
        // Map section names to folder types
        const sectionToFolderType = {
            'Sentry Detection': 'SentryClips',
            'User Saved': 'SavedClips'
        };

        const expectedFolderType = sectionToFolderType[selectedSection];
        
        if (!expectedFolderType) {
            console.warn(`Unknown section: ${selectedSection}, showing all events`);
            return true; // Show all events if section is unknown
        }

        const isFromCorrectSection = eventMarker.folderType === expectedFolderType;
        
        if (!isFromCorrectSection) {
            console.log(`🚫 Filtered out event: ${eventMarker.reason} (${eventMarker.folderType}) from section: ${selectedSection}`);
        }
        
        return isFromCorrectSection;
    }

    renderLegacyEventMarkers(timelineMarkers) {
        // Calculate timeline bounds using legacy method
        const timelineStart = this.currentTimeline.startTime.getTime();
        const timelineEnd = timelineStart + this.currentTimeline.displayDuration;

        // Get the selected date and section for filtering events
        const selectedDate = this.currentTimeline.date;
        const selectedSection = this.currentTimeline.sectionName;
        const selectedDateObj = new Date(selectedDate);
        const selectedDateStart = new Date(selectedDateObj.getFullYear(), selectedDateObj.getMonth(), selectedDateObj.getDate()).getTime();
        const selectedDateEnd = selectedDateStart + (24 * 60 * 60 * 1000); // End of the selected date

        console.log(`📅 Filtering events for date: ${selectedDate} (${new Date(selectedDateStart).toLocaleDateString()}) and section: ${selectedSection}`);

        // Filter events by the selected date, section type, AND timeline bounds
        const visibleEvents = this.eventMarkers.filter(eventMarker => {
            const eventTime = eventMarker.timestamp.getTime();
            const eventDate = eventMarker.timestamp.getTime();
            
            // Check if event is from the selected date
            const isFromSelectedDate = eventDate >= selectedDateStart && eventDate < selectedDateEnd;
            
            // Check if event is from the correct section type
            const isFromCorrectSection = this.isEventFromSection(eventMarker, selectedSection);
            
            // Check if event is within or after the timeline (for positioning at end)
            const isWithinTimeline = eventTime >= timelineStart;
            
            return isFromSelectedDate && isFromCorrectSection && isWithinTimeline;
        });

        // Create and position event markers
        visibleEvents.forEach(eventMarker => {
            const eventTime = eventMarker.timestamp.getTime();
            let relativePosition = eventTime - timelineStart;
            
            // If event is after timeline ends, position it at the very end
            if (eventTime > timelineEnd) {
                relativePosition = this.currentTimeline.displayDuration;
                console.log(`⚠️ Event after timeline end: ${eventMarker.reason} at ${eventMarker.timestamp.toLocaleTimeString()}, positioning at timeline end`);
            }
            
            const percentage = Math.max(0, Math.min(100, (relativePosition / this.currentTimeline.displayDuration) * 100));

            // Update marker position
            eventMarker.position = percentage;

            // Only create marker if it's within visible range
            if (percentage >= 0 && percentage <= 100) {
                const markerElement = this.createEventMarkerElement(eventMarker);
                timelineMarkers.appendChild(markerElement);
            }
        });

        console.log(`Rendered ${visibleEvents.length} event markers for selected date and section (${this.eventMarkers.length} total events)`);
    }

    createEventMarkerElement(eventMarker) {
        const marker = document.createElement('div');
        marker.className = `event-marker event-marker-${eventMarker.type}`;
        marker.style.left = `${eventMarker.position}%`;
        marker.innerHTML = eventMarker.emoji;
        marker.title = `${eventMarker.reason} - ${eventMarker.timestamp.toLocaleString()}`;

        // Add event listeners
        marker.addEventListener('click', (e) => this.handleEventMarkerClick(eventMarker, e));
        marker.addEventListener('mouseenter', (e) => this.handleEventMarkerHover(eventMarker, e));
        marker.addEventListener('mouseleave', () => this.hideEventTooltip());

        return marker;
    }

    handleEventMarkerClick(eventMarker, event) {
        console.log('Event marker clicked:', eventMarker.reason);

        // Calculate seek position (10 seconds before for context, similar to PyQt6 implementation)
        const eventTime = eventMarker.timestamp.getTime();
        
        if (this.currentTimeline.accurateTimeline) {
            // Use accurate timeline seeking
            const timelineStart = new Date(this.currentTimeline.startTime).getTime();
            const timelineEnd = new Date(this.currentTimeline.endTime).getTime();
            let relativePosition = eventTime - timelineStart;

            // If event is after timeline ends, seek to the end of the timeline
            if (eventTime > timelineEnd) {
                relativePosition = timelineEnd - timelineStart;
                console.log(`⚠️ Event after timeline end, seeking to timeline end: ${eventMarker.reason} at ${eventMarker.timestamp.toLocaleTimeString()}`);
            }

            // Seek 10 seconds before the event for context (but not before timeline start)
            const seekPosition = Math.max(0, relativePosition - 10000); // 10 seconds in milliseconds

            console.log(`🎯 Seeking to event marker: ${eventMarker.reason} at ${eventMarker.timestamp.toLocaleTimeString()}`);
            console.log(`⏱️ Event time: ${eventTime}, Timeline start: ${timelineStart}, Relative position: ${relativePosition}ms`);
            console.log(`🎬 Seeking to position: ${seekPosition}ms (${Math.round(seekPosition/1000)}s before event)`);

            // Use accurate timeline seeking
            this.seekToAccurateGlobalPosition(seekPosition);
        } else {
            // Fallback to legacy seeking
            const timelineStart = this.currentTimeline.startTime.getTime();
            const timelineEnd = timelineStart + this.currentTimeline.displayDuration;
            let relativePosition = eventTime - timelineStart;

            // If event is after timeline ends, seek to the end of the timeline
            if (eventTime > timelineEnd) {
                relativePosition = this.currentTimeline.displayDuration;
            }

            // Seek 10 seconds before the event for context
            const seekPosition = Math.max(0, relativePosition - 10000); // 10 seconds in milliseconds

            // Convert to percentage for seeking
            const seekPercentage = (seekPosition / this.currentTimeline.displayDuration) * 100;

            // Seek to position
            this.seekToPosition(seekPercentage);
        }

        // Hide tooltip
        this.hideEventTooltip();

        event.stopPropagation();
    }

    async handleEventMarkerHover(eventMarker, event) {
        console.log('Event marker hovered:', eventMarker.reason);

        try {
            // Load thumbnail if available
            let thumbnailSrc = null;
            if (eventMarker.thumbnailPath) {
                thumbnailSrc = await window.electronAPI.tesla.getEventThumbnail(eventMarker.thumbnailPath);
            }

            // Update tooltip content
            this.updateEventTooltip(eventMarker, thumbnailSrc);

            // Position and show tooltip
            this.showEventTooltip(event.clientX, event.clientY);

        } catch (error) {
            console.error('Error loading event thumbnail:', error);
            // Show tooltip without image
            this.updateEventTooltip(eventMarker, null);
            this.showEventTooltip(event.clientX, event.clientY);
        }
    }

    updateEventTooltip(eventMarker, thumbnailSrc) {
        const reasonElement = document.getElementById('event-tooltip-reason');
        const timeElement = document.getElementById('event-tooltip-time');
        const locationElement = document.getElementById('event-tooltip-location');
        const imgElement = document.getElementById('event-tooltip-img');

        // Format user-friendly reason text
        let friendlyReason = eventMarker.reason;
        if (eventMarker.reason === 'user_interaction') {
            friendlyReason = 'User Saved';
        } else if (eventMarker.reason.toLowerCase().includes('user_interaction') && eventMarker.reason.toLowerCase().includes('dashcam')) {
            friendlyReason = 'User Tapped the Dashcam';
        } else if (eventMarker.reason.toLowerCase().includes('user_interaction') && eventMarker.reason.toLowerCase().includes('honk')) {
            friendlyReason = 'User Honk';
        } else if (eventMarker.reason === 'sentry_aware_object_detection') {
            friendlyReason = 'Sentry Detected Object';
        } else if (eventMarker.reason === 'sentry_aware_acceleration') {
            friendlyReason = 'Sentry Detected Acceleration';
        } else if (eventMarker.reason === 'sentry_aware_turning') {
            friendlyReason = 'Sentry Detected Turning';
        } else if (eventMarker.reason.toLowerCase().includes('sentry')) {
            friendlyReason = 'Sentry Detection';
        } else {
            // Capitalize first letter and replace underscores with spaces
            friendlyReason = eventMarker.reason.replace(/_/g, ' ')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');
        }

        // Format date and time in user-friendly format
        const eventDate = eventMarker.timestamp;
        const dateStr = eventDate.toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        });
        const timeStr = eventDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        if (reasonElement) reasonElement.textContent = friendlyReason;
        if (timeElement) timeElement.textContent = `${dateStr} ${timeStr}`;
        if (locationElement) locationElement.textContent = eventMarker.city || 'Unknown location';

        if (imgElement) {
            if (thumbnailSrc) {
                console.log('Setting thumbnail src:', thumbnailSrc.substring(0, 50) + '...');
                imgElement.src = thumbnailSrc;
                imgElement.style.display = 'block';

                // Add error handler to debug loading issues
                imgElement.onerror = (e) => {
                    console.error('Failed to load thumbnail image:', e);
                    imgElement.style.display = 'none';
                };

                imgElement.onload = () => {
                    console.log('Thumbnail loaded successfully');
                };
            } else {
                console.log('No thumbnail src provided');
                imgElement.style.display = 'none';
            }
        }
    }

    showEventTooltip(x, y) {
        if (!this.eventTooltip) return;

        // Make tooltip visible temporarily to get its dimensions
        this.eventTooltip.style.visibility = 'hidden';
        this.eventTooltip.classList.remove('hidden');

        const tooltipRect = this.eventTooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Calculate preferred position (above cursor)
        let left = x - tooltipRect.width / 2;
        let top = y - tooltipRect.height - 15; // 15px gap above cursor

        // Check if tooltip would go off the bottom of the screen
        const wouldGoOffBottom = (y + tooltipRect.height + 15) > viewportHeight;
        const hasRoomAbove = (y - tooltipRect.height - 15) > 0;

        // If tooltip would go off bottom and there's room above, show above
        // Otherwise, show below cursor
        if (wouldGoOffBottom && hasRoomAbove) {
            top = y - tooltipRect.height - 15; // Above cursor
        } else {
            top = y + 15; // Below cursor
        }

        // Keep tooltip horizontally on screen
        if (left < 10) {
            left = 10;
        } else if (left + tooltipRect.width > viewportWidth - 10) {
            left = viewportWidth - tooltipRect.width - 10;
        }

        // Keep tooltip vertically on screen
        if (top < 10) {
            top = 10;
        } else if (top + tooltipRect.height > viewportHeight - 10) {
            top = viewportHeight - tooltipRect.height - 10;
        }

        // Apply final position and make visible
        this.eventTooltip.style.left = `${left}px`;
        this.eventTooltip.style.top = `${top}px`;
        this.eventTooltip.style.visibility = 'visible';

        console.log(`Tooltip positioned at (${left}, ${top}), cursor at (${x}, ${y}), viewport: ${viewportWidth}x${viewportHeight}`);
    }

    hideEventTooltip() {
        if (this.eventTooltip) {
            this.eventTooltip.classList.add('hidden');
            this.eventTooltip.style.visibility = 'visible'; // Reset visibility for next time
        }
    }

    clearEventMarkers() {
        // Clear markers array
        this.eventMarkers = [];

        // Remove DOM elements
        const timelineMarkers = document.getElementById('timeline-markers');
        if (timelineMarkers) {
            const existingEventMarkers = timelineMarkers.querySelectorAll('.event-marker');
            existingEventMarkers.forEach(marker => marker.remove());
        }

        // Hide tooltip
        this.hideEventTooltip();
    }

    // ===== CAMERA ZOOM SYSTEM =====

    setupCameraZoom() {
        console.log('Setting up camera zoom system...');

        try {
            // Initialize zoom and pan for all cameras
            const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
            cameras.forEach(camera => {
                this.cameraZoomLevels[camera] = 1.0; // Default zoom level
                this.cameraPanOffsets[camera] = { x: 0, y: 0 }; // Default pan offset

                // Add wheel event listener to each video container
                const container = document.querySelector(`[data-camera="${camera}"]`);
                const video = document.getElementById(`video-${camera}`);
                if (container) {
                    container.addEventListener('wheel', (e) => this.handleCameraZoom(e, camera), { passive: false });
                }
                if (video) {
                    this.setupCameraPan(video, camera);
                }
            });

            console.log('Camera zoom system initialized');
        } catch (error) {
            console.error('Error setting up camera zoom system:', error);
        }
    }

    setupCameraPan(video, camera) {
        let isPanning = false;
        let lastX = 0, lastY = 0;
        video.addEventListener('mousedown', (e) => {
            if ((this.cameraZoomLevels[camera] || 1.0) <= 1.0) return;
            // Allow panning if Ctrl+left click or right click (button 2)
            if (!(e.ctrlKey || e.button === 2)) return;
            isPanning = true;
            lastX = e.clientX;
            lastY = e.clientY;
            video.style.cursor = 'grabbing';
            if (e.button === 2) e.preventDefault(); // Prevent context menu on right drag
        });
        // Prevent context menu on right click
        video.addEventListener('contextmenu', (e) => {
            if ((this.cameraZoomLevels[camera] || 1.0) > 1.0) e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            const baseSpeed = 3.0;
            const currentZoom = this.cameraZoomLevels[camera] || 1.0;
            
            // Scale speed inversely with zoom level to maintain consistent panning feel
            // This ensures panning speed feels the same regardless of zoom level
            const adjustedSpeed = baseSpeed / currentZoom;
            
            const dx = (e.clientX - lastX) * adjustedSpeed;
            const dy = (e.clientY - lastY) * adjustedSpeed;
            lastX = e.clientX;
            lastY = e.clientY;
            const pan = this.cameraPanOffsets[camera] || { x: 0, y: 0 };
            
            // Check if this camera should be mirrored (back and repeater cameras)
            const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(camera);
            
            // For mirrored cameras, invert the X-axis panning direction
            if (isMirroredCamera) {
                pan.x -= dx;
            } else {
                pan.x += dx;
            }
            pan.y += dy;
            this.cameraPanOffsets[camera] = pan;
            this.setCameraZoom(camera, this.cameraZoomLevels[camera]);
        });
        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                video.style.cursor = '';
            }
        });
        video.addEventListener('mouseleave', () => {
            if (isPanning) {
                isPanning = false;
                video.style.cursor = '';
            }
        });
    }

    handleCameraZoom(event, camera) {
        event.preventDefault();

        // Calculate zoom factor (similar to PyQt6 implementation)
        const zoomFactor = event.deltaY > 0 ? 1 / 1.15 : 1.15;
        const currentZoom = this.cameraZoomLevels[camera];
        const newZoom = currentZoom * zoomFactor;

        // Apply zoom limits (1.0 to 7.0, same as PyQt6)
        if (newZoom < 1.0) {
            this.resetCameraZoom(camera);
        } else if (newZoom > 7.0) {
            // Don't zoom beyond maximum
            return;
        } else {
            // --- Mouse-centered zoom logic ---
            const video = document.getElementById(`video-${camera}`);
            if (video) {
                const rect = video.getBoundingClientRect();
                // Mouse position relative to video center
                const mouseX = event.clientX - rect.left;
                const mouseY = event.clientY - rect.top;
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                
                // Check if this camera should be mirrored (back and repeater cameras)
                const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(camera);
                
                // Offset from center, in video pixels
                let offsetX = mouseX - centerX;
                const offsetY = mouseY - centerY;
                
                // For mirrored cameras, we need to invert the X-axis offset
                // because the video is horizontally flipped with scaleX(-1)
                if (isMirroredCamera) {
                    offsetX = -offsetX;
                }
                
                // Calculate new pan so the point under the cursor stays fixed
                const pan = this.cameraPanOffsets[camera] || { x: 0, y: 0 };
                // The math: newPan = oldPan - (zoomDelta - 1) * offset
                // (zoomDelta = newZoom/currentZoom)
                const zoomDelta = newZoom / currentZoom;
                pan.x = (pan.x - offsetX) * zoomDelta + offsetX;
                pan.y = (pan.y - offsetY) * zoomDelta + offsetY;
                this.cameraPanOffsets[camera] = pan;
            }
            this.setCameraZoom(camera, newZoom);
        }
    }

    setCameraZoom(camera, zoomLevel) {
        const video = document.getElementById(`video-${camera}`);
        if (!video) return;

        // Store zoom level
        this.cameraZoomLevels[camera] = zoomLevel;

        // Check if this camera should be mirrored (back and repeater cameras)
        const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(camera);
        const pan = this.cameraPanOffsets[camera] || { x: 0, y: 0 };

        // Only allow panning if zoomed in
        let transform = '';
        if (isMirroredCamera) {
            transform += 'scaleX(-1) ';
        }
        if (zoomLevel > 1.0) {
            transform += `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})`;
        } else {
            transform += 'scale(1.0)';
        }
        video.style.transform = transform;
        video.style.transformOrigin = 'center center';
        video.style.transition = 'transform 0.1s ease-out';

        console.log(`Camera ${camera} zoom set to ${zoomLevel.toFixed(2)}x${isMirroredCamera ? ' (mirrored)' : ''}, pan: (${pan.x.toFixed(1)}, ${pan.y.toFixed(1)})`);
    }

    resetCameraZoom(camera) {
        const video = document.getElementById(`video-${camera}`);
        if (!video) return;

        // Reset zoom and pan
        this.cameraZoomLevels[camera] = 1.0;
        this.cameraPanOffsets[camera] = { x: 0, y: 0 };

        // Check if this camera should be mirrored (back and repeater cameras)
        const isMirroredCamera = ['back', 'left_repeater', 'right_repeater'].includes(camera);

        // Reset CSS transform, preserving mirroring for Tesla cameras
        if (isMirroredCamera) {
            video.style.transform = 'scaleX(-1) scale(1.0)';
        } else {
            video.style.transform = 'scale(1.0)';
        }
        video.style.transformOrigin = 'center center';
        video.style.transition = 'transform 0.2s ease-out';

        console.log(`Camera ${camera} zoom reset to 1.0x${isMirroredCamera ? ' (mirrored)' : ''}`);
    }

    resetAllCameraZoom() {
        const cameras = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
        cameras.forEach(camera => {
            this.resetCameraZoom(camera);
        });

        console.log('All camera zoom levels reset');
    }

    getCameraZoomLevel(camera) {
        return this.cameraZoomLevels[camera] || 1.0;
    }
}

// Make test function available globally
window.testTimeline = function() {
    if (window.sentrySixApp) {
        window.sentrySixApp.testTimelinePositioning();
    } else {
        console.log('❌ App not ready');
    }
};

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.sentrySixApp = new SentrySixApp();
});

// Handle app focus/blur for performance
window.addEventListener('focus', () => {
    console.log('App focused');
});

window.addEventListener('blur', () => {
    console.log('App blurred');
    // Could pause videos here to save resources
});

// Add this after initializing the export dialog and setting up event listeners:
window.electronAPI.on('export:process-started', (event, exportId) => {
    if (this.currentExportId === exportId) {
        const cancelExportBtn = document.getElementById('cancel-export-btn');
        if (cancelExportBtn) {
            cancelExportBtn.disabled = false;
            console.log('Cancel button enabled: export process is now tracked');
        }
    }
});

// ... existing code ...
window.electronAPI.on('export:cancelled', (event, exportId) => {
    if (this.currentExportId === exportId) {
        this.exportWasCancelled = true;
        alert('Export cancelled by user.');
        this.showStatus('Export cancelled.');
        this.closeExportDialog();
    }
});
// ... existing code ...
