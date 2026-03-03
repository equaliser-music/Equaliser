/**
 * Messages Page Module
 *
 * Direct messages with NIP-04 encryption, conversation list + chat UI.
 * Extracted from messages.html for use with the app shell router.
 */
(function() {
    'use strict';

    const MessagesPage = {
        _myPubkey: null,
        _conversations: new Map(),
        _convProfiles: new Map(),
        _activeConvPartner: null,
        _decryptedMessages: new Map(),
        _isSending: false,

        init(params) {
            // Expose global functions for onclick handlers
            window.selectConversation = (pk) => this._selectConversation(pk);
            window.sendMessage = () => this._sendMessage();

            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
                return;
            }
            this._myPubkey = session.publicKey;

            // Check DM capability
            if (typeof NostrDM === 'undefined' || !NostrDM.canDM()) {
                const layout = document.getElementById('messages-layout');
                if (layout) layout.innerHTML = `
                    <div class="dm-unavailable">
                        <svg width="48" height="48" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>
                        </svg>
                        <p>Direct messages require access to your private key for encryption.</p>
                        <p>Please <a href="/login.html?return=${encodeURIComponent(window.location.href)}">log in with your nsec</a> to use messages.</p>
                    </div>`;
                return;
            }

            this._loadConversations();
        },

        cleanup() {
            delete window.selectConversation;
            delete window.sendMessage;
            this._myPubkey = null;
            this._conversations = new Map();
            this._convProfiles = new Map();
            this._activeConvPartner = null;
            this._decryptedMessages = new Map();
            this._isSending = false;
        },

        // ===== Load Conversations =====

        async _loadConversations() {
            const allDMs = await NostrDM.fetchAllDMs(this._myPubkey);
            this._conversations = NostrDM.groupConversations(allDMs, this._myPubkey);

            const partnerPubkeys = [...this._conversations.keys()];
            if (partnerPubkeys.length > 0) {
                this._convProfiles = await NostrSocial.fetchProfiles(partnerPubkeys);
            }

            const privateKey = SessionManager.getPrivateKey();
            for (const [partner, conv] of this._conversations) {
                const lastMsg = conv.messages[conv.messages.length - 1];
                if (lastMsg && !this._decryptedMessages.has(lastMsg.id)) {
                    try {
                        const senderPubkey = lastMsg.pubkey === this._myPubkey ? partner : lastMsg.pubkey;
                        const plaintext = await NostrDM.decrypt(privateKey, senderPubkey, lastMsg.content);
                        this._decryptedMessages.set(lastMsg.id, plaintext);
                    } catch (e) {
                        this._decryptedMessages.set(lastMsg.id, '[Unable to decrypt]');
                    }
                }
            }

            this._renderLayout();

            // Check for npub param to auto-open
            const urlParams = new URLSearchParams(window.location.search);
            const npubParam = urlParams.get('npub');
            if (npubParam) {
                try {
                    const decoded = window.NostrTools.nip19.decode(npubParam);
                    if (decoded.type === 'npub') {
                        this._selectConversation(decoded.data);
                    }
                } catch (e) {}
            }
        },

        _renderLayout() {
            const escapeHtml = NostrSocial.escapeHtml;
            const sortedPartners = [...this._conversations.entries()]
                .sort((a, b) => b[1].lastMessageTime - a[1].lastMessageTime);

            let convListHtml = '';
            if (sortedPartners.length === 0) {
                convListHtml = `<div class="conv-list-empty">No conversations yet.<br>Visit a user's profile to send a message.</div>`;
            } else {
                convListHtml = sortedPartners.map(([partner, conv]) => {
                    const profile = this._convProfiles.get(partner) || {};
                    const name = profile.name || 'Unknown';
                    const initial = name.charAt(0).toUpperCase();
                    const lastMsg = conv.messages[conv.messages.length - 1];
                    const preview = this._decryptedMessages.get(lastMsg?.id) || '...';
                    const time = lastMsg ? NostrSocial.relativeTime(lastMsg.created_at) : '';
                    const isActive = partner === this._activeConvPartner;

                    return `
                        <div class="conv-item${isActive ? ' active' : ''}" onclick="selectConversation('${partner}')">
                            <div class="conv-avatar">
                                ${profile.picture
                                    ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                    : initial
                                }
                            </div>
                            <div class="conv-info">
                                <div class="conv-name">${escapeHtml(name)}</div>
                                <div class="conv-preview">${escapeHtml(preview.substring(0, 50))}</div>
                            </div>
                            <div class="conv-time">${time}</div>
                        </div>`;
                }).join('');
            }

            let chatHtml = '';
            if (this._activeConvPartner) {
                chatHtml = this._renderChat();
            } else {
                chatHtml = `
                    <div class="chat-empty">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/>
                            <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/>
                        </svg>
                        <p>Select a conversation to view messages</p>
                    </div>`;
            }

            const layout = document.getElementById('messages-layout');
            if (layout) layout.innerHTML = `
                <div class="conv-list">
                    <div class="conv-list-header">Messages</div>
                    <div class="conv-list-items">${convListHtml}</div>
                </div>
                <div class="chat-view">${chatHtml}</div>`;

            if (this._activeConvPartner) {
                this._setupChatComposer();
                this._scrollChatToBottom();
            }
        },

        async _selectConversation(partnerPubkey) {
            this._activeConvPartner = partnerPubkey;

            if (!this._conversations.has(partnerPubkey)) {
                this._conversations.set(partnerPubkey, { messages: [], lastMessageTime: 0 });
                if (!this._convProfiles.has(partnerPubkey)) {
                    const profiles = await NostrSocial.fetchProfiles([partnerPubkey]);
                    profiles.forEach((v, k) => this._convProfiles.set(k, v));
                }
            }

            const conv = this._conversations.get(partnerPubkey);
            const privateKey = SessionManager.getPrivateKey();
            for (const msg of conv.messages) {
                if (!this._decryptedMessages.has(msg.id)) {
                    try {
                        const senderPubkey = msg.pubkey === this._myPubkey ? partnerPubkey : msg.pubkey;
                        const plaintext = await NostrDM.decrypt(privateKey, senderPubkey, msg.content);
                        this._decryptedMessages.set(msg.id, plaintext);
                    } catch (e) {
                        this._decryptedMessages.set(msg.id, '[Unable to decrypt]');
                    }
                }
            }

            this._renderLayout();
        },

        _renderChat() {
            const escapeHtml = NostrSocial.escapeHtml;
            const conv = this._conversations.get(this._activeConvPartner);
            const profile = this._convProfiles.get(this._activeConvPartner) || {};
            const name = profile.name || 'Unknown';
            const initial = name.charAt(0).toUpperCase();
            let npub = '';
            try { npub = window.NostrTools.nip19.npubEncode(this._activeConvPartner); } catch (e) {}

            let messagesHtml = '';
            let lastDay = '';
            for (const msg of (conv?.messages || [])) {
                const day = new Date(msg.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                if (day !== lastDay) {
                    messagesHtml += `<div class="msg-day-divider">${day}</div>`;
                    lastDay = day;
                }

                const isOutgoing = msg.pubkey === this._myPubkey;
                const plaintext = this._decryptedMessages.get(msg.id);
                const time = new Date(msg.created_at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                if (plaintext === '[Unable to decrypt]') {
                    messagesHtml += `<div class="msg-error">Could not decrypt message</div>`;
                } else {
                    messagesHtml += `
                        <div class="msg-row ${isOutgoing ? 'outgoing' : 'incoming'}">
                            <div>
                                <div class="msg-bubble ${isOutgoing ? 'outgoing' : 'incoming'}">${escapeHtml(plaintext || '...')}</div>
                                <div class="msg-time">${time}</div>
                            </div>
                        </div>`;
                }
            }

            if (!conv || conv.messages.length === 0) {
                messagesHtml = `<div class="chat-empty"><p>No messages yet. Say hello!</p></div>`;
            }

            return `
                <div class="chat-header">
                    <div class="chat-header-avatar">
                        ${profile.picture
                            ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                            : initial
                        }
                    </div>
                    <div>
                        <div class="chat-header-name">${npub ? `<a href="/user.html?npub=${npub}">${escapeHtml(name)}</a>` : escapeHtml(name)}</div>
                        <div class="chat-header-handle">${npub ? npub.substring(0, 20) + '...' : ''}</div>
                    </div>
                </div>
                <div class="chat-messages" id="chat-messages">${messagesHtml}</div>
                <div class="chat-composer">
                    <textarea id="chat-input" placeholder="Type a message..." rows="1"></textarea>
                    <button class="chat-send-btn" id="chat-send-btn" disabled onclick="sendMessage()">Send</button>
                </div>`;
        },

        _setupChatComposer() {
            const input = document.getElementById('chat-input');
            const sendBtn = document.getElementById('chat-send-btn');
            if (!input || !sendBtn) return;

            input.addEventListener('input', () => {
                sendBtn.disabled = input.value.trim().length === 0 || this._isSending;
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!sendBtn.disabled) this._sendMessage();
                }
            });
        },

        _scrollChatToBottom() {
            const el = document.getElementById('chat-messages');
            if (el) el.scrollTop = el.scrollHeight;
        },

        async _sendMessage() {
            const input = document.getElementById('chat-input');
            const sendBtn = document.getElementById('chat-send-btn');
            const text = input?.value?.trim();
            if (!text || this._isSending || !this._activeConvPartner) return;

            this._isSending = true;
            if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }

            try {
                const signedEvent = await NostrDM.sendDM(this._activeConvPartner, text);

                const conv = this._conversations.get(this._activeConvPartner);
                if (conv) {
                    conv.messages.push(signedEvent);
                    conv.lastMessageTime = signedEvent.created_at;
                }
                this._decryptedMessages.set(signedEvent.id, text);

                if (input) { input.value = ''; input.style.height = 'auto'; }
                this._renderLayout();
            } catch (error) {
                console.error('Send DM failed:', error);
                alert('Failed to send message: ' + error.message);
            } finally {
                this._isSending = false;
                if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
            }
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.messages = MessagesPage;
})();
