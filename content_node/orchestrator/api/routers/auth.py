"""
Auth router — role resolution endpoint.

Provides /api/auth/whoami for the admin UI to discover the
authenticated user's role and managed artists.
"""

from fastapi import APIRouter, Depends

from dependencies import require_role, RoleContext

router = APIRouter()


@router.get("/whoami")
async def whoami(ctx: RoleContext = Depends(require_role)):
    """
    Return the authenticated user's role and managed artists.

    Used by admin-sidebar.js to render role-appropriate navigation.
    """
    return {
        "pubkey": ctx.pubkey,
        "role": ctx.role,
        "managed_artists": ctx.managed_artists,
    }
