FROM nginx:alpine
COPY index.html sim.js /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
