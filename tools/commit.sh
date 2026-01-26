#!/bin/bash
#
# Commit and push changes to origin
# Usage: ./tools/commit.sh "Commit message"
#        ./tools/commit.sh -m "Commit message"
#        ./tools/commit.sh (interactive - will prompt for message)
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Parse arguments
COMMIT_MSG=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--message)
            COMMIT_MSG="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [options] [message]"
            echo ""
            echo "Options:"
            echo "  -m, --message MSG   Commit message"
            echo "  -h, --help          Show this help"
            echo ""
            echo "Examples:"
            echo "  $0 \"Fix bug in upload handler\""
            echo "  $0 -m \"Add new feature\""
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
