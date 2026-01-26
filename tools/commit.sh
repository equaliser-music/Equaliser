#!/bin/bash
#
# Commit and push changes to origin
# Usage: ./tools/commit.sh "Commit message"
#        ./tools/commit.sh -m "Commit message"
#        ./tools/commit.sh --auto              # Auto-generate message from changes
#        ./tools/commit.sh                     # Interactive (prompts for message)
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Parse arguments
COMMIT_MSG=""
AUTO_GENERATE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--message)
            COMMIT_MSG="$2"
            shift 2
            ;;
        -a|--auto)
            AUTO_GENERATE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options] [message]"
            echo ""
            echo "Options:"
            echo "  -m, --message MSG   Commit message"
            echo "  -a, --auto          Auto-generate commit message from changes"
            echo "  -h, --help          Show this help"
            echo ""
            echo "Examples:"
            echo "  $0 \"Fix bug in upload handler\""
            echo "  $0 -m \"Add new feature\""
            echo "  $0 --auto"
            exit 0
            ;;
        *)
            # Assume it's the commit message
            COMMIT_MSG="$1"
            shift
            ;;
    esac
done

# Check for changes
echo -e "${BLUE}Checking for changes...${NC}"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo -e "${YELLOW}No changes to commit.${NC}"
    exit 0
fi

# Show status
echo -e "${BLUE}Current changes:${NC}"
git status --short

echo ""

# Auto-generate commit message if requested
if [ "$AUTO_GENERATE" = true ]; then
    echo -e "${BLUE}Analyzing changes to generate commit message...${NC}"

    # Stage all changes first so we can analyze them
    git add -A

    # Get the diff stats
    DIFF_STAT=$(git diff --cached --stat)
    DIFF_CONTENT=$(git diff --cached --no-color)

    # Count files changed
    FILES_CHANGED=$(git diff --cached --name-only | wc -l | tr -d ' ')

    # Get list of changed files
    CHANGED_FILES=$(git diff --cached --name-only)

    # Categorize changes
    NEW_FILES=$(git diff --cached --name-status | grep "^A" | cut -f2 || true)
    MODIFIED_FILES=$(git diff --cached --name-status | grep "^M" | cut -f2 || true)
    DELETED_FILES=$(git diff --cached --name-status | grep "^D" | cut -f2 || true)

    # Build a summary
    SUMMARY_PARTS=()

    # Check for specific patterns in changed files
    if echo "$CHANGED_FILES" | grep -q "tools/"; then
        SUMMARY_PARTS+=("tools")
    fi
    if echo "$CHANGED_FILES" | grep -q "docs/"; then
        SUMMARY_PARTS+=("documentation")
    fi
    if echo "$CHANGED_FILES" | grep -q "orchestrator/api/"; then
        SUMMARY_PARTS+=("API")
    fi
    if echo "$CHANGED_FILES" | grep -q "\.html$"; then
        SUMMARY_PARTS+=("UI")
    fi
    if echo "$CHANGED_FILES" | grep -q "\.py$"; then
        SUMMARY_PARTS+=("Python")
    fi
    if echo "$CHANGED_FILES" | grep -q "\.js$"; then
        SUMMARY_PARTS+=("JavaScript")
    fi
    if echo "$CHANGED_FILES" | grep -q "docker"; then
        SUMMARY_PARTS+=("Docker")
    fi
    if echo "$CHANGED_FILES" | grep -q "CLAUDE.md"; then
        SUMMARY_PARTS+=("project config")
    fi

    # Detect action type
    ACTION=""
    if [ -n "$NEW_FILES" ] && [ -z "$MODIFIED_FILES" ] && [ -z "$DELETED_FILES" ]; then
        ACTION="Add"
    elif [ -z "$NEW_FILES" ] && [ -z "$MODIFIED_FILES" ] && [ -n "$DELETED_FILES" ]; then
        ACTION="Remove"
    elif [ -n "$NEW_FILES" ]; then
        ACTION="Add"
    else
        ACTION="Update"
    fi

    # Build message based on what changed
    if [ ${#SUMMARY_PARTS[@]} -eq 0 ]; then
        # Generic message
        COMMIT_MSG="${ACTION} changes to ${FILES_CHANGED} file(s)"
    elif [ ${#SUMMARY_PARTS[@]} -eq 1 ]; then
        COMMIT_MSG="${ACTION} ${SUMMARY_PARTS[0]}"
    else
        # Join with commas and 'and'
        LAST_IDX=$((${#SUMMARY_PARTS[@]} - 1))
        MSG_PARTS=""
        for i in "${!SUMMARY_PARTS[@]}"; do
            if [ $i -eq 0 ]; then
                MSG_PARTS="${SUMMARY_PARTS[$i]}"
            elif [ $i -eq $LAST_IDX ]; then
                MSG_PARTS="${MSG_PARTS} and ${SUMMARY_PARTS[$i]}"
            else
                MSG_PARTS="${MSG_PARTS}, ${SUMMARY_PARTS[$i]}"
            fi
        done
        COMMIT_MSG="${ACTION} ${MSG_PARTS}"
    fi

    # Add detail about specific files if only a few changed
    if [ "$FILES_CHANGED" -le 3 ]; then
        FILE_NAMES=$(git diff --cached --name-only | xargs -I{} basename {} | tr '\n' ', ' | sed 's/,$//')
        COMMIT_MSG="${COMMIT_MSG} (${FILE_NAMES})"
    fi

    echo ""
    echo -e "${CYAN}Generated commit message:${NC}"
    echo -e "${GREEN}  ${COMMIT_MSG}${NC}"
    echo ""
    echo -e "${YELLOW}Press Enter to accept, or type a new message:${NC}"
    read -r USER_INPUT
    if [ -n "$USER_INPUT" ]; then
        COMMIT_MSG="$USER_INPUT"
    fi
else
    # Get commit message if not provided
    if [ -z "$COMMIT_MSG" ]; then
        echo -e "${YELLOW}Enter commit message (Ctrl+C to cancel):${NC}"
        read -r COMMIT_MSG
        if [ -z "$COMMIT_MSG" ]; then
            echo -e "${RED}Error: Commit message cannot be empty${NC}"
            exit 1
        fi
    fi

    # Stage all changes
    echo -e "${BLUE}Staging changes...${NC}"
    git add -A
fi

# Show what will be committed
echo -e "${BLUE}Files to be committed:${NC}"
git diff --cached --stat

echo ""

# Create commit with co-author
echo -e "${BLUE}Creating commit...${NC}"
git commit -m "$(cat <<EOF
${COMMIT_MSG}

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Push to origin
echo -e "${BLUE}Pushing to origin/${BRANCH}...${NC}"
git push origin "$BRANCH"

echo ""
echo -e "${GREEN}Done! Changes committed and pushed to origin/${BRANCH}${NC}"

# Show the commit
echo ""
echo -e "${BLUE}Latest commit:${NC}"
git log -1 --oneline
