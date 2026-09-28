FROM nginx:alpine
COPY index.html sim.js icon.png /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
# revalidate every load so a redeploy shows up without a hard reload
RUN echo 'add_header Cache-Control "no-cache";' > /etc/nginx/conf.d/nocache.conf
