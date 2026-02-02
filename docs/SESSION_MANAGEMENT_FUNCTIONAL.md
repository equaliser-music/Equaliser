# Session Management Solution: Functional Overview

## The Problem

The current Equaliser admin pages (Profile Editor, Settings) require artists to enter their NOSTR private key (nsec) on every page load. This creates poor user experience:

- Artists must re-enter their nsec when switching between Profile and Settings
- Private keys are sensitive - repeatedly typing them increases exposure risk
- The workflow feels tedious and discourages artists from using the admin tools
- No clear indication of authentication state across pages

## The Solution

A centralized session management system that allows artists to **log in once per browser session** and maintain authentication across all admin pages until they explicitly log out or close their browser.

## Core Design Principles

### 1. Single Login Point

Instead of every page asking for credentials, there is now:

- **One dedicated login page** where artists authenticate once
- All other admin pages check if a session exists
- If no session exists, pages automatically redirect to the login page
- After login, artists are sent back to the page they originally requested

This mirrors familiar patterns from other web applications (Gmail, Twitter, etc.) where you log in once and navigate freely.

### 2. In-Memory Session Storage

The authentication state lives **only in memory** within the JavaScript runtime:

- When an artist logs in, their keys are stored in a module-level variable
- This variable persists as long as the browser tab remains open
- Pages within the admin section can access this shared session state
- The session disappears completely when the tab closes or is navigated away from

**Why in-memory only?**
- No risk of keys being recovered from browser storage after session ends
- Automatically cleared when browser tab closes (built-in cleanup)
- Cannot be accessed by other websites or browser extensions
- Maintains the strongest security posture for sensitive key material

### 3. Session Lifecycle Management

The session has a clear lifecycle with multiple termination conditions:

**Session Creation:**
- Artist visits any admin page (Profile, Settings, etc.)
- System detects no active session
- Redirects to login page
- Artist enters nsec or connects browser extension
- Session created in memory
- Artist redirected back to original destination

**Session Active:**
- Session persists across page loads within the admin section
- Artist can freely navigate between Profile, Settings, and future admin pages
- No additional authentication required
- Visual status bar shows authentication state

**Session Termination:**
- **Explicit logout**: Artist clicks "Logout" button
- **Idle timeout**: 30 minutes without any user activity (mouse, keyboard, scroll) AND no audio playing
- **Browser closure**: Closing the tab automatically clears memory
- **External navigation**: Leaving the admin section clears the session
- **Multi-tab sync**: Logging out in one tab logs out all tabs

Note: The idle timeout is intelligent about music listening - if an artist is playing tracks in the background, the session remains active even without mouse/keyboard interaction. This prevents frustrating mid-stream logouts.

## Key Components

### Login Gateway

A dedicated authentication page that serves as the single entry point:

**Manual Authentication:**
- Artist enters their NOSTR private key (nsec format)
- System validates the key format
- Derives public key and creates signing capability
- Stores authentication state in memory
- Redirects to requested admin page

**Browser Extension Authentication:**
- Detects if artist has NOSTR extension installed (Alby, nos2x, etc.)
- Requests public key from extension
- Creates session that delegates signing to the extension
- Extension manages keys - they never enter the browser at all
- More secure option for artists with extensions

**Backup File Authentication:**
- Accepts `equaliser-backup-*.json` files from onboarding
- Parses keys and profile data from the backup
- Creates session using the nsec from the backup
- Stores profile data in sessionStorage for the profile page to pre-fill
- Enables identity recovery across browsers or after reinstallation

**Return URL Handling:**
- System remembers which page the artist was trying to access
- After successful login, sends them directly there
- Prevents "login then find your page again" friction

### Session Manager

A central coordination layer that all admin pages interact with:

**Authentication Checking:**
- Pages call a "require session" function on load
- If session exists: page proceeds normally
- If no session exists: automatic redirect to login

**Session Retrieval:**
- Any page can request current session details
- Receives public key, signing capability, session metadata
- Uses these to interact with NOSTR network

**Activity Monitoring:**
- Tracks user interactions (mouse movements, clicks, typing, scrolling)
- Monitors audio/video playback state
- Resets idle timeout whenever activity detected or audio is playing
- Prevents premature logout while artist is actively working or listening
- Smart detection: playing music counts as activity even without interaction

**Timeout Enforcement:**
- Checks elapsed time since last activity every minute
- If 30 minutes passed with no activity: clear session and redirect to login
- Configurable timeout duration for different security requirements

**Cleanup Coordination:**
- Listens for browser tab closing events
- Overwrites sensitive key material before releasing memory
- Signals other open tabs when logout occurs
- Removes all traces of authentication state

### Status Bar

A visual component that appears on all authenticated admin pages:

**Authentication Indicator:**
- Green pulsing dot showing active session
- Shortened version of public key (npub) for identification
- Session duration display (e.g., "Active 45m")

**Navigation:**
- Quick links to Profile, Settings, and other admin pages
- Highlights current page location
- Enables fluid movement through admin section

**Logout Control:**
- Prominent logout button
- Single click to end session and return to login
- Prevents accidental "stuck logged in" scenarios

## User Experience Flow

### First Time Using Admin Tools

1. Artist clicks link to Profile Editor or Settings
2. System detects no authentication
3. Redirects to clean, friendly login page
4. Artist enters nsec, connects extension, or loads backup file
5. Returns to Profile Editor (or wherever they were headed)
6. Status bar appears at top showing they're logged in

### Recovering Identity from Backup

1. Artist loads `equaliser-backup-*.json` on login page
2. System extracts keys and validates the backup format
3. Creates session from the nsec in the backup
4. Stores profile data temporarily for the profile page
5. Redirects to requested page (or dashboard)
6. If profile page is visited, form fields pre-fill from backup data
7. Artist can review and publish to update their NOSTR profile

### Working Across Multiple Pages

1. Artist finishes updating profile
2. Clicks "Settings" in status bar
3. Page loads immediately - no login prompt
4. Makes configuration changes
5. Clicks "Profile" to go back
6. Seamless navigation - session maintained throughout

### Ending Session

**Normal logout:**
1. Artist clicks "Logout" in status bar
2. Keys cleared from memory
3. Returns to login page
4. If artist has multiple admin tabs open, all simultaneously logout

**Idle timeout:**
1. Artist leaves computer
2. 30 minutes pass with no activity
3. System checks if audio is playing
4. If music is playing: session stays active, timer resets
5. If no audio playing: system logs out
6. Returns to login with message: "Session expired due to inactivity"

**Browser closure:**
1. Artist closes tab
2. Session automatically cleared from memory
3. Next time they open admin page: login required

## Multi-Tab Behavior

### Logging In Multiple Times

If an artist opens multiple admin tabs:
- Each tab needs its own login (sessions don't share across tabs)
- This is intentional: prevents session hijacking if someone else opens a tab
- Artists working actively will maintain session in their main tab

### Synchronized Logout

When artist logs out:
- The tab they clicked logout in: immediate logout
- All other admin tabs: receive logout signal via browser storage events
- All tabs simultaneously redirect to login page
- Prevents "logged out in one tab but still in another" confusion

This synchronization works across tabs but respects tab isolation for login.

## Security Characteristics

### What This Protects Against

**Browser storage attacks:**
- Keys never written to localStorage/sessionStorage
- Even if malicious script runs, nothing to steal from persistent storage
- Session ends completely when browser closes

**Session hijacking:**
- Sessions don't persist across browser restarts
- Each tab requires its own authentication
- Idle timeout prevents abandoned session exploitation

**Key exposure:**
- Keys entered only once per session
- Extension mode keeps keys in dedicated extension (never in browser)
- Explicit cleanup overwrites key data before memory release

### What Artists Should Still Protect

**Initial key entry:**
- System cannot protect against keyloggers on compromised computers
- Artists should only log in from trusted devices

**Physical access:**
- If someone has access to an active session, they have full privileges
- Artists should logout when leaving computers unattended
- Idle timeout provides backstop if they forget

**Key custody:**
- System manages keys during session, but artists responsible for nsec storage
- Encourage use of password managers or hardware wallets
- Browser extension is best practice for regular use

## Technical Boundaries

### What Works

- Logging in and navigating across all admin pages
- Maintaining session during active work
- Automatic cleanup on various termination conditions
- Support for both manual and extension-based authentication
- Multi-tab logout coordination

### What Doesn't Work

- Session persistence across browser restarts (intentional security choice)
- Session sharing across multiple browser tabs (intentional security choice)
- Recovering a session if keys are lost (impossible by design)
- Working offline without initial login (NOSTR requires network)

### Configuration Options

**Timeout duration:**
- Default: 30 minutes of inactivity
- Can be adjusted for different security/convenience tradeoffs
- Shorter timeout (15 min) for higher security contexts
- Longer timeout (1 hour) for intensive work sessions

**Extension preference:**
- Can prioritize extension login over manual entry
- Can disable manual entry entirely for security-conscious deployments
- Can make extension login the default/recommended option

## Migration Path

### For Existing Admin Pages

Each existing admin page needs three changes:

**Add session management:**
- Include the session management scripts
- Add session status bar scripts
- Pages gain authentication UI automatically

**Check authentication on load:**
- Replace manual nsec prompts with session check
- If no session: redirect to login
- If session exists: continue page logic

**Use session for signing:**
- Replace direct key usage with session signing function
- Session handles key access and signing internally
- Pages don't need to manage keys directly

### For New Admin Pages

New admin pages start with session management:

**Standard template:**
- Include session scripts in header
- Call session requirement function on page load
- Use session for all NOSTR operations
- Status bar appears automatically

**Consistent experience:**
- All admin pages work identically
- Artists learn the pattern once
- New features feel integrated

## Future Enhancements

### Potential Improvements

**Biometric unlock:**
- Use WebAuthn/passkeys for device-level security
- Face ID or fingerprint instead of typing nsec
- Keys encrypted with device secure element

**Remember this device:**
- Optional: securely cache session across browser restarts
- Would require careful encryption implementation
- Tradeoff between convenience and security

**Session activity log:**
- Track when artist logged in from where
- Alert on unusual access patterns
- Help artists monitor their account security

**Multiple identity support:**
- Artists with multiple NOSTR identities could switch between them
- Quick identity switching without full logout/login
- Useful for artists managing multiple projects

**Delegated signing keys:**
- Support NOSTR key delegation (NIP-26)
- Use temporary signing keys instead of master key
- Further reduces exposure of primary identity key

## Conclusion

This session management system transforms the admin experience from "enter credentials on every page" to "log in once and work freely." It maintains the security guarantee that keys never touch persistent storage while dramatically improving usability.

The design balances multiple concerns:
- **Security**: Keys only in memory, automatic cleanup, idle timeout
- **Usability**: Single login, seamless navigation, clear status
- **Reliability**: Handles edge cases, multi-tab coordination, error recovery
- **Flexibility**: Works with extensions or manual entry, configurable timeout

Artists can now focus on their content rather than authentication mechanics, while maintaining the strong security guarantees essential for managing NOSTR identities.
