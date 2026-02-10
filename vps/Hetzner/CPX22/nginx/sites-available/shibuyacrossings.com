# shibuyacrossings.com - Static band website
#
# Serves static files from /var/www/shibuyacrossings.com/html/

server {
    listen 80;
    listen [::]:80;
    server_name shibuyacrossings.com www.shibuyacrossings.com;

    root /var/www/shibuyacrossings.com/html;
    index index.html;

    # Certbot will add redirect to HTTPS here

    # NIP-05 identity verification (NOSTR)
    location /.well-known/nostr.json {
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS' always;
        add_header 'Content-Type' 'application/json' always;

        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }

    location / {
        try_files $uri $uri/ =404;
    }

    # Cache static assets
    location ~* \.(css|js|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1000;
}
