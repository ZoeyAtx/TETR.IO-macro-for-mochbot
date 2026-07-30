// ==UserScript==
// @name         TETR.IO Full Lobby Automation
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Press Cmd+Shift+E (Mac) / Ctrl+Shift+E (Win/Linux) to navigate to a private room, configure it, invite MOCHBOT, save, and send a chat message
// @match        *://tetr.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const MOCHBOT_ID = '6a29aed006b09a34e50338c8';
    const CHAT_MESSAGE = '>pps 0.6';

    const POLL_INTERVAL_MS = 100;
    const NAV_STEP_TIMEOUT_MS = 6000;   // waiting for each menu screen to load
    const SOCIAL_WAIT_TIMEOUT_MS = 3000;
    const POST_INVITE_CLOSE_DELAY_MS = 200; // wait after inviting + closing socials tab, before chat is allowed
    const MAX_BACK_CLICKS = 10;
    const BACK_CLICK_DELAY_MS = 400;

    // ---------- low-level helpers ----------

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
    ).set;

    function setReactInputValue(input, value) {
        if (!input) return false;
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function waitForElement(selector, timeoutMs) {
        return new Promise((resolve) => {
            const start = performance.now();
            (function poll() {
                const el = document.querySelector(selector);
                if (el) return resolve(el);
                if (performance.now() - start >= timeoutMs) return resolve(null);
                setTimeout(poll, POLL_INTERVAL_MS);
            })();
        });
    }

    function showToast(message, success = true) {
        const toast = document.createElement('div');
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: 999999,
            padding: '10px 16px',
            borderRadius: '6px',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            fontWeight: 'bold',
            color: '#fff',
            background: success ? '#2e8b57' : '#b22222',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            transition: 'opacity 0.4s ease',
            opacity: '1',
            pointerEvents: 'none',
            maxWidth: '320px',
        });
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, 2000);
    }

    function clickMiddleOfScreen() {
        const x = Math.floor(window.innerWidth / 2);
        const y = Math.floor(window.innerHeight / 2);
        const el = document.elementFromPoint(x, y);
        if (el) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
        }
    }

    function dispatchEnterKey(el) {
        ['keydown', 'keypress', 'keyup'].forEach((type) => {
            const event = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
            Object.defineProperty(event, 'keyCode', { get: () => 13 });
            Object.defineProperty(event, 'which', { get: () => 13 });
            el.dispatchEvent(event);
        });
    }

    // ---------- header / state detection ----------

    // Reads #header_text to figure out where we are on the site.
    // Returns 'LOGIN' (no header element -> pre-join screen), 'HOME', 'MULTIPLAYER', or 'UNKNOWN'.
    function getHeaderState() {
        const headerEl = document.getElementById('header_text');
        if (!headerEl) return 'LOGIN';

        const text = headerEl.textContent.trim().toUpperCase();
        if (text === 'HOME') return 'HOME';
        if (text === 'MULTIPLAYER') return 'MULTIPLAYER';
        return 'UNKNOWN';
    }

    // ---------- navigation ----------

    async function clickJoinIfPresent() {
        const joinBtn = document.getElementById('return_button');
        if (joinBtn) {
            console.log('[TETR.IO Automation] Clicking JOIN to enter the app.');
            joinBtn.click();
            await sleep(800);
            return true;
        }
        return false;
    }

    // Backs out of whatever screen we're on until the multiplayer menu tile is visible.
    // Used as a fallback when the header state can't be identified (e.g. mid-match, in a submenu).
    async function goToMainMenu() {
        if (document.getElementById('play_multi')) return true;

        for (let i = 0; i < MAX_BACK_CLICKS; i++) {
            if (document.getElementById('play_multi')) return true;

            const exitBtn = document.getElementById('leavezenith');
            const backBtn = document.getElementById('back');

            if (exitBtn) {
                exitBtn.click();
            } else if (backBtn) {
                backBtn.click();
            } else {
                break; // nothing left to click; either at menu already, or stuck
            }
            await sleep(BACK_CLICK_DELAY_MS);
        }

        return !!document.getElementById('play_multi');
    }

    async function navigateToPrivateRoom() {
        let headerState = getHeaderState();
        console.log('[TETR.IO Automation] Detected header state: ' + headerState);

        if (headerState === 'UNKNOWN') {
            // Not on login/home/multiplayer - try to back out to the main menu first,
            // then treat it like HOME from there.
            const atMenu = await goToMainMenu();
            if (!atMenu) {
                console.warn('[TETR.IO Automation] Unknown screen and could not back out to main menu.');
                return false;
            }
            headerState = 'HOME';
        }

        if (headerState === 'LOGIN') {
            await clickJoinIfPresent();
        }

        // LOGIN and HOME both need the multiplayer tile clicked; MULTIPLAYER is already past that.
        if (headerState === 'LOGIN' || headerState === 'HOME') {
            const playMultiBtn = await waitForElement('#play_multi', NAV_STEP_TIMEOUT_MS);
            if (!playMultiBtn) {
                console.warn('[TETR.IO Automation] #play_multi did not appear.');
                return false;
            }
            playMultiBtn.click();
        }

        const createRoomTile = await waitForElement('#multi_createroom', NAV_STEP_TIMEOUT_MS);
        if (!createRoomTile) {
            console.warn('[TETR.IO Automation] #multi_createroom did not appear.');
            return false;
        }
        createRoomTile.click();

        const privateRoomTile = await waitForElement('[data-id="private"]', NAV_STEP_TIMEOUT_MS);
        if (!privateRoomTile) {
            console.warn('[TETR.IO Automation] Private room tile ([data-id="private"]) did not appear.');
            return false;
        }
        privateRoomTile.click();

        const roomLoaded = await waitForElement(
            'input.room_config_item[data-index="options.g"]',
            NAV_STEP_TIMEOUT_MS
        );
        if (!roomLoaded) {
            console.warn('[TETR.IO Automation] Room settings screen did not load after selecting private room.');
            return false;
        }

        return true;
    }

    // ---------- room configuration ----------

    function resetGravitySettings() {
        const gravityInput = document.querySelector('input.room_config_item[data-index="options.g"]');
        const gravityMarginInput = document.querySelector('input.room_config_item[data-index="options.gincrease"]');

        const gravityOk = setReactInputValue(gravityInput, '0');
        const marginOk = setReactInputValue(gravityMarginInput, '0');

        if (!gravityOk || !marginOk) {
            console.warn('[TETR.IO Automation] Could not find one or both gravity inputs.');
        }
        return gravityOk && marginOk;
    }

    function setMatchFT() {
        const ftInput = document.querySelector('input.room_config_item[data-index="match.ft"]');
        const ok = setReactInputValue(ftInput, '5');
        if (!ok) console.warn('[TETR.IO Automation] Could not find match.ft input.');
        return ok;
    }

    // Opens the social tray, invites MOCHBOT, closes the tray, then waits
    // POST_INVITE_CLOSE_DELAY_MS before returning - this is what gates the chat message.
    async function inviteMochbotViaSocialTray() {
        const socialTray = document.getElementById('social_tray');
        if (!socialTray) {
            console.warn('[TETR.IO Automation] Social tray element not found.');
            return false;
        }

        socialTray.click();

        const mochbotEl = await waitForElement('#social_relationship_' + MOCHBOT_ID, SOCIAL_WAIT_TIMEOUT_MS);
        if (!mochbotEl) {
            console.warn('[TETR.IO Automation] MOCHBOT did not appear in social list in time.');
            clickMiddleOfScreen();
            await sleep(POST_INVITE_CLOSE_DELAY_MS);
            return false;
        }

        const inviteBtn = mochbotEl.querySelector('.social_relationship_button_invite');
        if (!inviteBtn) {
            console.warn('[TETR.IO Automation] Invite button not found on MOCHBOT element.');
            clickMiddleOfScreen();
            await sleep(POST_INVITE_CLOSE_DELAY_MS);
            return false;
        }

        inviteBtn.click();
        await sleep(150);
        clickMiddleOfScreen(); // closes the socials tab
        await sleep(POST_INVITE_CLOSE_DELAY_MS); // gate: chat message must not send before this resolves
        return true;
    }

    function saveRoomSettings() {
        const saveBtn = document.getElementById('room_opts_save');
        if (!saveBtn) {
            console.warn('[TETR.IO Automation] Save button not found.');
            return false;
        }
        saveBtn.click();
        return true;
    }

    function sendChatMessage(message) {
        const chatInput = document.getElementById('chat_input');
        if (!chatInput) {
            console.warn('[TETR.IO Automation] #chat_input not found.');
            return false;
        }
        setReactInputValue(chatInput, message);
        dispatchEnterKey(chatInput);
        return true;
    }

    // ---------- orchestration ----------

    async function runFullAutomation() {
        // Navigation always runs, and always starts by checking the header
        // (see getHeaderState() inside navigateToPrivateRoom).
        const navOk = await navigateToPrivateRoom();

        if (!navOk) {
            showToast('Navigation failed — check console', false);
            return;
        }

        const gravityOk = resetGravitySettings();
        const ftOk = setMatchFT();

        // inviteMochbotViaSocialTray() already waits POST_INVITE_CLOSE_DELAY_MS internally
        // after closing the socials tab, so nothing after this point can fire early.
        const inviteOk = await inviteMochbotViaSocialTray();

        const saveOk = saveRoomSettings();
        await sleep(1000); // let save settle before touching chat

        const chatOk = sendChatMessage(CHAT_MESSAGE);

        const allOk = gravityOk && ftOk && inviteOk && saveOk && chatOk;

        if (allOk) {
            showToast('Room set up, MOCHBOT invited, saved, chat sent', true);
        } else {
            const failures = [];
            if (!gravityOk) failures.push('gravity');
            if (!ftOk) failures.push('match FT');
            if (!inviteOk) failures.push('invite');
            if (!saveOk) failures.push('save');
            if (!chatOk) failures.push('chat');
            showToast('Failed: ' + failures.join(', '), false);
        }
    }

    document.addEventListener(
        'keydown',
        (e) => {
            const modifierPressed = e.metaKey || e.ctrlKey;
            const keyMatches = e.key === 'E' || e.key === 'e';

            if (modifierPressed && e.shiftKey && keyMatches) {
                e.preventDefault();
                e.stopPropagation();
                runFullAutomation();
            }
        },
        true
    );

    console.log('[TETR.IO Automation] Loaded. Press Cmd/Ctrl+Shift+E to run full lobby setup.');
})();
