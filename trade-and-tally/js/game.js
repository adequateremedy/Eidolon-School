/* js/game.js */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";

// FIREBASE SETUP
const firebaseConfig = {
    apiKey: "AIzaSyAeyOzh9YHaQDMSvn-8-ZyVqXkwY_diL5Y",
    authDomain: "solus-dynasty-rpg.firebaseapp.com",
    projectId: "solus-dynasty-rpg"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

setPersistence(auth, browserLocalPersistence).catch((error) => {
    console.error("Persistence error:", error);
});

// DATA LOGIC
let gDriveToken = localStorage.getItem("gDriveToken") || null;
let dataFileId = null;
let playerJsonData = {};
let charData = {}; 

async function fetchWithTimeout(url, options, ms = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function buildDefaultPlayerData() {
    return {
        account: { unlockedStars: 1, dismissedUpdates: [], seenUpdates: [] },
        stars: {
            "1": {
                starName: "",
                isComplete: false,
                gens: {
                    "1": {
                        era: "Steampunk", realm: "Midgard", characterName: "", portraitUrl: "", portraitId: "",
                        level: 1, exp: 0, birthBookCompleted: false, birthBookExpAwarded: false,
                        schoolProgress: { class1: false, class2: false, class3: false, class4: false, class5: false },
                        journalEntries: [], rpSessions: [], inventory: [], versions: { runicFally: 2 }
                    },
                    "2": { unlocked: false }, "3": { unlocked: false }, "4": { unlocked: false }, "5": { unlocked: false }, "zenith": { unlocked: false }
                }
            },
            "2": { unlocked: false }, "3": { unlocked: false }, "4": { unlocked: false }, "5": { unlocked: false }
        }
    };
}

async function createDriveDataFile(contentObj) {
    const metadata = {
        name: 'character_data.json',
        parents: ['appDataFolder'],
        mimeType: 'application/json'
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(contentObj)], { type: 'application/json' }));

    const res = await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${gDriveToken}` },
        body: form
    });
    if (res.status === 401) throw new Error("Token Expired");
    const result = await res.json();
    if (result.id) dataFileId = result.id;
}

async function syncDriveData(scoreDisplay, roundDisplay) {
    try {
        const res = await fetchWithTimeout("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='character_data.json'", {
            headers: { 'Authorization': `Bearer ${gDriveToken}` }
        });
        if (res.status === 401) throw new Error("Token Expired");
        const data = await res.json();
        if (data.files && data.files.length > 0) {
            dataFileId = data.files[0].id;
            const fileRes = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${dataFileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${gDriveToken}` }
            });
            if (fileRes.status === 401) throw new Error("Token Expired");
            playerJsonData = await fileRes.json();
        } else {
            playerJsonData = buildDefaultPlayerData();
            await createDriveDataFile(playerJsonData);
        }
    } catch (err) {
        if (err.message === "Token Expired") throw err;
        console.error("Drive sync failed:", err);
        document.getElementById("sync-error-screen").classList.add("active");
        return false;
    }

    if (playerJsonData.stars && playerJsonData.stars["1"] && playerJsonData.stars["1"].gens && playerJsonData.stars["1"].gens["1"]) {
        charData = playerJsonData.stars["1"].gens["1"];
    } else {
        charData = playerJsonData;
    }

    if (charData.class2Points === undefined) charData.class2Points = 0;
    if (charData.class2Round === undefined) charData.class2Round = 1;
    if (charData.schoolProgress === undefined) {
        charData.schoolProgress = { class1: false, class2: false, class3: false, class4: false, class5: false };
    }

    // If the game was closed mid-round last visit, the device kept the boxes
    // shipped that round. Take them back when Drive still shows them unshipped.
    try {
        const stashRaw = localStorage.getItem("ttClass2Stash");
        if (stashRaw) {
            const stash = JSON.parse(stashRaw);
            if (stash.forRound === charData.class2Round && stash.baseScore === charData.class2Points && stash.score > charData.class2Points) {
                charData.class2Points = stash.score;
            } else if (charData.class2Points >= stash.score) {
                localStorage.removeItem("ttClass2Stash");
            }
        }
    } catch (e) { console.error("Round restore failed:", e); }
    
    // Update the UI immediately after pulling the save
    scoreDisplay.innerText = `Score: ${charData.class2Points} / 2000`;
    roundDisplay.innerText = `Round: ${charData.class2Round} / 5`;
    return true;
}

// SIGN-IN & TOKEN RECOVERY
// When a save can't go through because the sign-in expired, the game says so
// on its own sign-in screen and finishes the save once the player signs in.
let pendingRetry = null;
let signInInFlight = false;

function showSignIn(message) {
    if (message) document.getElementById("signin-msg").innerText = message;
    document.getElementById("signin-screen").classList.add("active");
    document.dispatchEvent(new CustomEvent('tt-signin-open'));
}

function hideSignIn() {
    document.getElementById("signin-screen").classList.remove("active");
    document.dispatchEvent(new CustomEvent('tt-signin-close'));
}

async function doSignIn() {
    signInInFlight = true;
    try {
        const provider = new GoogleAuthProvider();
        provider.addScope('https://www.googleapis.com/auth/drive.appdata');
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential) {
            gDriveToken = credential.accessToken;
            localStorage.setItem("gDriveToken", gDriveToken);
        }
        return result.user;
    } finally {
        signInInFlight = false;
    }
}

async function finishSignIn() {
    hideSignIn();
    if (pendingRetry) {
        const pending = pendingRetry;
        pendingRetry = null;
        await pending.fn();
        if (pending.url) { window.location.href = pending.url; return; }
    }
}

async function safeAction(actionFunc, redirectUrl = null) {
    try {
        await actionFunc();
        if (redirectUrl) window.location.href = redirectUrl;
    } catch (err) {
        if (err.message === "Token Expired" || err.status === 401) {
            pendingRetry = { fn: actionFunc, url: redirectUrl };
            showSignIn("Your sign-in expired. Sign in again so your progress can be saved safely.");
        } else {
            console.error("Action failed:", err);
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    // UI Elements
    const introScreen = document.getElementById("intro-screen");
    const gameScreen = document.getElementById("game-screen");
    const roundResultsScreen = document.getElementById("round-results-screen");
    const victoryScreen = document.getElementById("victory-screen");
    const beginOverlay = document.getElementById("begin-overlay");
    const pauseScreen = document.getElementById("pause-screen");
    const glossaryGrid = document.getElementById("glossary-grid");
    const howtoScreen = document.getElementById("howto-screen");
    
    const startBtn = document.getElementById("start-btn");
    const beginBtn = document.getElementById("begin-btn");
    const nextRoundBtn = document.getElementById("next-round-btn");
    const pauseBtn = document.getElementById("pause-btn");
    const resumeBtn = document.getElementById("resume-btn");
    const returnHubBtn = document.getElementById("return-hub-btn");
    const soundBtn = document.getElementById("sound-btn");
    const resetClassBtn = document.getElementById("reset-class-btn");
    const resetClassBtnIntro = document.getElementById("reset-class-btn-intro");
    
    const roundDisplay = document.getElementById("round-display");
    const truckDisplay = document.getElementById("truck-display");
    const scoreDisplay = document.getElementById("score-display");
    const resultsStats = document.getElementById("results-stats");
    
    const movingBelt = document.getElementById("moving-belt");
    const itemTrack = document.getElementById("item-track");
    const boxesContainer = document.getElementById("boxes-container");
    
    const bgMusic = document.getElementById("bg-music");
    bgMusic.volume = 0.5;
    bgMusic.muted = localStorage.getItem("ttMuted") === "1";

    // Game State
    let currentRound = 1;
    let score = 0;
    let gameActive = false;
    let isPaused = false;
    let beltSpeed = 1.0; 
    let beltPos = 0;
    let currentSpawnDistance = 125;
    let distanceSinceLastSpawn = 125; 
    
    let activeItems = [];
    let activeBoxesData = {};
    let boxIdCounter = 0;
    
    let totalBoxesThisRound = 0;
    let boxesShippedThisRound = 0;
    let boxesSpawnedThisRound = 0;
    let activeBoxesCount = 0;
    let roundStartScore = 0;
    let signInOpen = false;

    document.addEventListener('tt-signin-open', () => { signInOpen = true; });
    document.addEventListener('tt-signin-close', () => { signInOpen = false; });

    function showIntroResetIfComplete() {
        if (charData.class2Points >= 2000 || (charData.schoolProgress && charData.schoolProgress.class2)) {
            resetClassBtnIntro.classList.remove("hidden");
        }
    }

    // Load Drive Data on Auth State
    let booted = false;
    async function bootGame() {
        if (booted) return;
        try {
            const ok = await syncDriveData(scoreDisplay, roundDisplay);
            if (ok) {
                booted = true;
                score = charData.class2Points;
                currentRound = charData.class2Round;
                showIntroResetIfComplete();
            }
        } catch (err) {
            if (err.message === "Token Expired") {
                pendingRetry = { fn: () => bootGame(), url: null };
                showSignIn("Your sign-in expired. Sign in again so your progress can load.");
            } else {
                console.error("Boot failed:", err);
            }
        }
    }

    onAuthStateChanged(auth, async (user) => {
        if (user && gDriveToken) {
            await bootGame();
        } else if (!signInInFlight) {
            showSignIn(user
                ? "Your Google sign-in needs a refresh so the game can reach your saved progress."
                : "You need to be signed in to play this class, so your progress can be saved.");
        }
    });

    async function saveDriveData() {
        charData.class2Points = score;
        charData.class2Round = currentRound;
        
        if (!dataFileId) {
            await createDriveDataFile(playerJsonData);
            localStorage.removeItem("ttClass2Stash");
            return;
        }
        
        const res = await fetchWithTimeout(`https://www.googleapis.com/upload/drive/v3/files/${dataFileId}?uploadType=media`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${gDriveToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(playerJsonData)
        });
        
        if (res.status === 401) throw new Error("Token Expired");
        localStorage.removeItem("ttClass2Stash");
    }

    // Audio Playlist State
    const playlist = ['assets/audio/Packing-Boxes.mp3', 'assets/audio/Daily-Grind.mp3'];
    let currentTrackIndex = 0;

    bgMusic.addEventListener('ended', () => {
        currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
        bgMusic.src = playlist[currentTrackIndex];
        if(!isPaused && gameActive) {
            bgMusic.play().catch(e => console.log(e));
        }
    });

    // Categories and Exactly Matched Items
    const itemsData = {
        mechanical_parts: ['Bolt-removebg-preview.png', 'Bracket-removebg-preview.png', 'Hinge-removebg-preview.png', 'Nut-removebg-preview.png', 'Piston-removebg-preview.png', 'Rivet-removebg-preview.png', 'Screw-removebg-preview.png', 'Spring-removebg-preview.png', 'Valve-removebg-preview.png', 'Washer-removebg-preview.png'],
        tools: ['Calipers-removebg-preview.png', 'Chisel-removebg-preview.png', 'Drill-removebg-preview.png', 'File-removebg-preview.png', 'Hackksaw-removebg-preview.png', 'Hammer-removebg-preview.png', 'Mallet-removebg-preview.png', 'Pliers-removebg-preview.png', 'Screwdriver-removebg-preview.png', 'Wrench-removebg-preview.png'],
        gears_cogs: ['Cam.png', 'Cog.png', 'Crank.png', 'FlyWheel.png', 'Gear.png', 'Main-Spring.png', 'Pinion.png', 'Rachet.png', 'Spindel.png', 'Sprocket.png'],
        raw_materials: ['Coal-Chunk.png', 'Glass-Shard.png', 'Leather-Scrap.png', 'Ore.png', 'Pipe.png', 'Plate.png', 'Rubber-Tubing.png', 'Sheet-Metal.png', 'Wire-Spool.png', 'Wood-Block.png'],
        navigation: ['Compass.png', 'Lantern.png', 'Magnifying-Lens.png', 'Matchbox.png', 'Monocle.png', 'Oil-Flask.png', 'Pocket-Watch.png', 'Sextant.png', 'Spyglass.png', 'Sundial.png'] 
    };

    // Exactly 40 boxes total across 5 rounds
    const boxesPerRound = [6, 7, 8, 9, 10];
    
    let activeCategories = [];
    let junkChance = 0;

    const DISPLAY_NAMES = {
        'Hackksaw-removebg-preview.png': 'Hacksaw',
        'Rachet.png': 'Ratchet',
        'Spindel.png': 'Spindle'
    };

    function getDisplayName(filename) {
        if (DISPLAY_NAMES[filename]) return DISPLAY_NAMES[filename];
        return filename.replace('-removebg-preview.png', '').replace('.png', '').replace(/-/g, ' ');
    }

    // Auto-generate the Glossary Grid for the Pause Screen
    function generateGlossary() {
        glossaryGrid.innerHTML = '';
        for (let category in itemsData) {
            itemsData[category].forEach(filename => {
                let itemDiv = document.createElement("div");
                itemDiv.className = "glossary-item";
                
                let nameLabel = document.createElement("div");
                nameLabel.className = "glossary-name";
                nameLabel.innerText = getDisplayName(filename);
                
                let img = document.createElement("img");
                img.src = `assets/images/items/${category}/${filename}`;
                img.alt = getDisplayName(filename);
                
                itemDiv.appendChild(nameLabel);
                if (category === 'navigation') {
                    let tag = document.createElement("div");
                    tag.className = "glossary-tag";
                    tag.innerText = "Rounds 3-4: do not pack. Round 5: real item.";
                    itemDiv.appendChild(tag);
                }
                itemDiv.appendChild(img);
                glossaryGrid.appendChild(itemDiv);
            });
        }
    }
    
    generateGlossary();

    // Button Listeners (WITH SAFETY NET)
    startBtn.addEventListener("click", () => {
        introScreen.classList.remove("active");
        setupRound(currentRound);
    });

    beginBtn.addEventListener("click", () => {
        beginOverlay.style.display = 'none';
        isPaused = false;
        bgMusic.play().catch(e => console.log(e));
        startGameplay();
    });

    async function resetClass2() {
        score = 0;
        currentRound = 1;
        if (charData.schoolProgress) charData.schoolProgress.class2 = false;
        localStorage.removeItem("ttClass2Stash");
        currentTrackIndex = 0;
        bgMusic.src = playlist[0];
        await saveDriveData();
        victoryScreen.classList.remove("active");
        introScreen.classList.remove("active");
        resetClassBtnIntro.classList.add("hidden");
        setupRound(1);
    }

    resetClassBtn.addEventListener("click", () => {
        const confirmReset = confirm("Are you sure you want to retake Class 2? All progress and points for this class will be erased.");
        if (confirmReset) {
            safeAction(resetClass2);
        }
    });

    resetClassBtnIntro.addEventListener("click", () => {
        const confirmReset = confirm("Are you sure you want to restart Class 2? All progress and points for this class will be erased.");
        if (confirmReset) {
            safeAction(resetClass2);
        }
    });

    // How to Play (from the intro screen and the pause screen)
    document.getElementById("howto-btn-intro").addEventListener("click", () => {
        howtoScreen.classList.add("active");
    });
    document.getElementById("howto-btn-pause").addEventListener("click", () => {
        howtoScreen.classList.add("active");
    });
    document.getElementById("howto-close-btn").addEventListener("click", () => {
        howtoScreen.classList.remove("active");
    });

    // Sound on/off (remembered between visits)
    function refreshSoundBtn() { soundBtn.innerText = bgMusic.muted ? "Sound: Off" : "Sound: On"; }
    soundBtn.addEventListener("click", () => {
        bgMusic.muted = !bgMusic.muted;
        localStorage.setItem("ttMuted", bgMusic.muted ? "1" : "0");
        refreshSoundBtn();
    });
    refreshSoundBtn();

    // Sign-in screen buttons
    document.getElementById("signin-btn").addEventListener("click", async () => {
        try {
            await doSignIn();
            await finishSignIn();
        } catch (err) {
            console.error("Sign-in failed:", err);
            document.getElementById("signin-msg").innerText = "Sign-in didn't finish. Please try again.";
        }
    });
    document.getElementById("signin-hub-btn").addEventListener("click", () => {
        window.location.href = "https://adequateremedy.github.io/RPG-Hub/";
    });
    document.getElementById("sync-retry-btn").addEventListener("click", () => {
        window.location.reload();
    });

    nextRoundBtn.addEventListener("click", () => {
        roundResultsScreen.classList.remove("active");
        currentRound++;
        safeAction(saveDriveData).then(() => {
            setupRound(currentRound);
        });
    });

    returnHubBtn.addEventListener("click", () => {
        let isComplete = charData.schoolProgress && charData.schoolProgress.class2;
        
        // Mark as complete if they beat Round 5 OR hit the 2000 score threshold early
        if ((currentRound >= 5 || score >= 2000) && !isComplete) {
            charData.schoolProgress.class2 = true;
            isComplete = true;
        }

        const url = isComplete 
            ? "https://adequateremedy.github.io/RPG-Hub/?class2Complete=true" 
            : "https://adequateremedy.github.io/RPG-Hub/";

        safeAction(saveDriveData, url);
    });

    // Pause functionality
    pauseBtn.addEventListener("click", togglePause);
    resumeBtn.addEventListener("click", togglePause);

    function togglePause() {
        if (!gameActive) return; 
        
        isPaused = !isPaused;
        
        if (isPaused) {
            bgMusic.pause();
            pauseScreen.classList.add("active");
        } else {
            pauseScreen.classList.remove("active");
            bgMusic.play().catch(e => console.log(e));
        }
    }

    function setupRound(round) {
        currentRound = round;
        roundStartScore = score;
        activeItems = [];
        activeBoxesData = {};
        boxIdCounter = 0;
        isPaused = false;
        
        totalBoxesThisRound = boxesPerRound[currentRound - 1] || 10;
        boxesShippedThisRound = 0;
        boxesSpawnedThisRound = 0;
        activeBoxesCount = 0;

        itemTrack.innerHTML = '';
        boxesContainer.innerHTML = '';
        beginOverlay.style.display = 'flex'; 
        pauseScreen.classList.remove("active");

        roundDisplay.innerText = `Round: ${currentRound} / 5`;
        truckDisplay.innerText = `On the Truck: 0 / ${totalBoxesThisRound}`;
        scoreDisplay.innerText = `Score: ${score} / 2000`;

        gameScreen.classList.add("active");

        setupRoundConfig();
        distanceSinceLastSpawn = currentSpawnDistance; 
        maintainBoxes();
        
        movingBelt.style.animation = 'none';
    }

    function startGameplay() {
        gameActive = true;
        distanceSinceLastSpawn = currentSpawnDistance; 
        requestAnimationFrame(updateGame);
    }

    function setupRoundConfig() {
        const speeds = [1.0, 1.2, 1.5, 1.8, 2.1];
        beltSpeed = speeds[currentRound - 1] || 2.1;

        const spawnDistances = [125, 150, 175, 200, 225];
        currentSpawnDistance = spawnDistances[currentRound - 1] || 225;

        if (currentRound === 1) { activeCategories = ['mechanical_parts']; junkChance = 0; }
        else if (currentRound === 2) { activeCategories = ['mechanical_parts', 'tools']; junkChance = 0; }
        else if (currentRound === 3) { activeCategories = ['mechanical_parts', 'tools']; junkChance = 0.2; }
        else if (currentRound === 4) { activeCategories = ['mechanical_parts', 'tools', 'raw_materials']; junkChance = 0.3; }
        else { activeCategories = ['mechanical_parts', 'tools', 'raw_materials', 'gears_cogs', 'navigation']; junkChance = 0; }
    }

    function maintainBoxes() {
        while (activeBoxesCount < 3 && boxesSpawnedThisRound < totalBoxesThisRound) {
            spawnBox();
            activeBoxesCount++;
            boxesSpawnedThisRound++;
        }
    }

    function spawnBox() {
        let boxId = `box-${boxIdCounter++}`;
        let category = activeCategories[Math.floor(Math.random() * activeCategories.length)];
        
        let boxData = { category: category, req: {}, elementId: boxId };
        let numTypes = 2; 
        
        let itemsOnBelt = activeItems.map(itemObj => itemObj.el.dataset.filename);
        let availableItems = itemsData[category].filter(filename => !itemsOnBelt.includes(filename));
        
        if (availableItems.length < numTypes) {
            availableItems = [...itemsData[category]];
        }

        for(let i=0; i<numTypes; i++) {
            let randIndex = Math.floor(Math.random() * availableItems.length);
            let itemFile = availableItems.splice(randIndex, 1)[0];
            let reqAmount = Math.floor(Math.random() * 3) + 1;
            boxData.req[itemFile] = { count: 0, required: reqAmount };
        }
        
        activeBoxesData[boxId] = boxData;
        renderBox(boxData);
    }

    function renderBox(boxData) {
        let boxWrapper = document.createElement('div');
        boxWrapper.className = 'box-wrapper';
        boxWrapper.id = `wrapper-${boxData.elementId}`;

        let tallyBoard = document.createElement('div');
        tallyBoard.className = 'tally-board';
        
        let ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        ul.style.margin = '0';
        
        Object.keys(boxData.req).forEach(itemName => {
            let li = document.createElement('li');
            li.className = 'tally-item';
            li.id = `tally-${boxData.elementId}-${itemName}`;
            let img = document.createElement('img');
            img.src = `assets/images/items/${boxData.category}/${itemName}`;
            img.alt = getDisplayName(itemName);
            let text = document.createElement('span');
            text.className = 'tally-text';
            text.innerText = `${getDisplayName(itemName)}: 0 / ${boxData.req[itemName].required}`;
            li.appendChild(img);
            li.appendChild(text);
            ul.appendChild(li);
        });
        tallyBoard.appendChild(ul);

        let dropBox = document.createElement('div');
        dropBox.className = 'drop-box';
        dropBox.dataset.boxId = boxData.elementId;
        dropBox.dataset.category = boxData.category;

        boxWrapper.appendChild(tallyBoard);
        boxWrapper.appendChild(dropBox);
        boxesContainer.appendChild(boxWrapper);
    }

    function spawnItem() {
        if (!gameActive || isPaused || signInOpen) return;

        let isJunk = Math.random() < junkChance;
        let category, itemFile;

        if (isJunk) {
            category = 'navigation';
            itemFile = itemsData[category][Math.floor(Math.random() * itemsData[category].length)];
        } else {
            let neededPool = [];
            Object.values(activeBoxesData).forEach(box => {
                Object.keys(box.req).forEach(item => {
                    if (box.req[item].count < box.req[item].required) {
                        neededPool.push({ cat: box.category, file: item });
                    }
                });
            });

            if (neededPool.length > 0 && Math.random() < 0.35) {
                let chosen = neededPool[Math.floor(Math.random() * neededPool.length)];
                category = chosen.cat;
                itemFile = chosen.file;
            } else {
                category = activeCategories[Math.floor(Math.random() * activeCategories.length)];
                itemFile = itemsData[category][Math.floor(Math.random() * itemsData[category].length)];
            }
        }

        let itemEl = document.createElement('div');
        itemEl.className = 'game-item';
        itemEl.style.backgroundImage = `url('assets/images/items/${category}/${itemFile}')`;
        itemEl.dataset.category = category;
        itemEl.dataset.filename = itemFile;

        if (category === 'navigation' && !activeCategories.includes('navigation')) {
            let badge = document.createElement('span');
            badge.className = 'junk-badge';
            itemEl.appendChild(badge);
        }
        
        let startX = itemTrack.offsetWidth;
        itemEl.style.left = startX + 'px';
        
        itemTrack.appendChild(itemEl);
        
        let itemObj = { el: itemEl, x: startX, isDragging: false };
        activeItems.push(itemObj);

        setupDrag(itemObj);
    }

    function removeItem(itemObj) {
        if (itemObj._handlers) {
            document.removeEventListener('mousemove', itemObj._handlers.move);
            document.removeEventListener('mouseup', itemObj._handlers.end);
            document.removeEventListener('touchmove', itemObj._handlers.move);
            document.removeEventListener('touchend', itemObj._handlers.end);
        }
        itemObj.el.remove();
        activeItems = activeItems.filter(i => i !== itemObj);
    }

    function updateGame() {
        if (!gameActive) return;

        if (!isPaused && !signInOpen) {
            beltPos -= beltSpeed;
            distanceSinceLastSpawn += beltSpeed;
            movingBelt.style.backgroundPosition = `${beltPos}px 0`;

            for (let i = activeItems.length - 1; i >= 0; i--) {
                let item = activeItems[i];
                if (!item.isDragging) {
                    item.x -= beltSpeed; 
                    item.el.style.left = item.x + 'px';
                    item.el.style.top = '50%'; 

                    if (item.x < -150) { 
                        let isNeeded = false;
                        let filename = item.el.dataset.filename;
                        Object.values(activeBoxesData).forEach(box => {
                            if (box.req[filename] && box.req[filename].count < box.req[filename].required) {
                                isNeeded = true;
                            }
                        });

                        if (isNeeded) {
                            // A needed item circles back to the start of the belt
                            item.x = itemTrack.offsetWidth;
                            item.el.style.left = item.x + 'px';
                        } else {
                            removeItem(item);
                        }
                    }
                }
            }

            if (distanceSinceLastSpawn >= currentSpawnDistance) {
                spawnItem();
                distanceSinceLastSpawn = 0;
            }
        }

        if (gameActive) {
            requestAnimationFrame(updateGame);
        }
    }

    function setupDrag(itemObj) {
        let el = itemObj.el;
        let offsetX = 0, offsetY = 0;
        
        const startDrag = (e) => {
            if (!gameActive || isPaused || signInOpen) return;
            itemObj.isDragging = true;
            el.style.zIndex = 100;
            let clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
            let clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
            let rect = el.getBoundingClientRect();
            offsetX = clientX - rect.left;
            offsetY = clientY - rect.top;
        };

        const moveDrag = (e) => {
            if (!itemObj.isDragging || !gameActive || isPaused) return;
            e.preventDefault(); 
            let clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
            let clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
            el.style.position = 'fixed'; 
            el.style.left = (clientX - offsetX) + 'px';
            el.style.top = (clientY - offsetY) + 'px';
        };

        const endDrag = (e) => {
            if (!itemObj.isDragging || !gameActive || isPaused) return;
            itemObj.isDragging = false;
            el.style.zIndex = 5;

            let clientX, clientY;
            if (e.type.includes('mouse')) {
                clientX = e.clientX;
                clientY = e.clientY;
            } else {
                clientX = e.changedTouches[0].clientX;
                clientY = e.changedTouches[0].clientY;
            }
            
            el.style.position = 'absolute';

            checkDropZone(itemObj, clientX, clientY);
        };

        itemObj._handlers = { move: moveDrag, end: endDrag };

        el.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', moveDrag);
        document.addEventListener('mouseup', endDrag);

        el.addEventListener('touchstart', startDrag, {passive: false});
        document.addEventListener('touchmove', moveDrag, {passive: false});
        document.addEventListener('touchend', endDrag);
    }

    function fumbleItem(itemObj, dropX) {
        let el = itemObj.el;
        el.classList.add('fumble');
        setTimeout(() => el.classList.remove('fumble'), 450);
        let trackRect = itemTrack.getBoundingClientRect();
        let maxX = Math.max(0, itemTrack.offsetWidth - el.offsetWidth);
        itemObj.x = Math.min(Math.max(dropX - trackRect.left - el.offsetWidth / 2, 0), maxX);
        el.style.left = itemObj.x + 'px';
        el.style.top = '50%';
    }

    function checkDropZone(itemObj, dropX, dropY) {
        let el = itemObj.el;
        let category = el.dataset.category;
        let filename = el.dataset.filename;

        let boxes = document.querySelectorAll('.drop-box');
        let droppedInBox = null;

        boxes.forEach(box => {
            let rect = box.getBoundingClientRect();
            if (dropX >= rect.left && dropX <= rect.right && dropY >= rect.top && dropY <= rect.bottom) {
                droppedInBox = box;
            }
        });

        if (droppedInBox) {
            let targetBoxId = droppedInBox.dataset.boxId;
            let targetBoxData = activeBoxesData[targetBoxId];
            let reqData = targetBoxData.req[filename];

            if (category === 'navigation' && !activeCategories.includes('navigation')) {
                fumbleItem(itemObj, dropX);
                return;
            }

            if (category !== targetBoxData.category) {
                fumbleItem(itemObj, dropX);
                return;
            }
            
            if (!reqData) {
                fumbleItem(itemObj, dropX);
                return;
            }
            if (reqData.count >= reqData.required) {
                fumbleItem(itemObj, dropX);
                return;
            }

            reqData.count++;
            let tallyLi = document.getElementById(`tally-${targetBoxId}-${filename}`);
            let displayName = getDisplayName(filename);
            tallyLi.querySelector('.tally-text').innerText = `${displayName}: ${reqData.count} / ${reqData.required}`;
            
            if (reqData.count === reqData.required) {
                tallyLi.classList.add('complete');
            }

            removeItem(itemObj);
            
            checkBoxComplete(targetBoxId);
            return;
        } 
        
        let visibleBelt = document.getElementById('moving-belt');
        let beltRect = visibleBelt.getBoundingClientRect();
        
        if (dropX >= beltRect.left && dropX <= beltRect.right && dropY >= beltRect.top && dropY <= beltRect.bottom) {
            let trackRect = document.getElementById('item-track').getBoundingClientRect();
            itemObj.x = dropX - trackRect.left; 
            return;
        }

        fumbleItem(itemObj, dropX);
    }

    function checkBoxComplete(boxId) {
        let boxData = activeBoxesData[boxId];
        let allComplete = true;
        
        Object.values(boxData.req).forEach(req => {
            if (req.count < req.required) allComplete = false;
        });

        if (allComplete) {
            // Updated score to yield exactly 2000 points over 40 boxes (50 per box)
            score += 50;
            try {
                localStorage.setItem("ttClass2Stash", JSON.stringify({
                    forRound: currentRound,
                    baseScore: roundStartScore,
                    score: score
                }));
            } catch (e) { console.error("Round stash failed:", e); }
            boxesShippedThisRound++;
            activeBoxesCount--;
            
            scoreDisplay.innerText = `Score: ${score} / 2000`;
            truckDisplay.innerText = `On the Truck: ${boxesShippedThisRound} / ${totalBoxesThisRound}`;
            
            document.getElementById(`wrapper-${boxId}`).remove();
            delete activeBoxesData[boxId];

            if (boxesShippedThisRound >= totalBoxesThisRound) {
                endRoundSuccess();
            } else {
                maintainBoxes(); 
            }
        }
    }

    function endRoundSuccess() {
        gameActive = false;
        bgMusic.pause();
        
        setTimeout(() => {
            if (currentRound < 5) {
                resultsStats.innerText = `Boxes Shipped: ${boxesShippedThisRound}\nCurrent Score: ${score} / 2000`;
                gameScreen.classList.remove("active");
                roundResultsScreen.classList.add("active");
            } else {
                gameScreen.classList.remove("active");
                victoryScreen.classList.add("active");
            }
        }, 1000);
    }

});
