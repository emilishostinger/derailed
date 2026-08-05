FROM nginx:1.27-alpine

COPY index.html /usr/share/nginx/html/index.html
COPY default.conf.template /etc/nginx/templates/default.conf.template

# The nginx image substitutes ${PORT} into the template at startup, so this fixture
# also proves that Derailed's injected PORT is what the app actually listens on.
EXPOSE 3000
