# The profile is like a schema rather than a working instance
# These steps seed initial values and then the gateway refreshes the access_token before expiry
# Key item is that credential-key is the env-var in the profile, not the name

openshell provider create \
    --workspace paperclip \
    --name anthropic-egress \
    --type anthropic-egress \
    --credential "ANTHROPIC_OAUTH_TOKEN=<working-oauth-token>"

openshell provider refresh configure anthropic-egress \
    --workspace paperclip \
    --strategy oauth2-refresh-token \
    --credential-key ANTHROPIC_OAUTH_TOKEN \
    --material client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e \
    --material refresh_token=<working-refresh-token>

