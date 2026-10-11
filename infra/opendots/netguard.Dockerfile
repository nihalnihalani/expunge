FROM alpine:3.22
RUN apk add --no-cache iptables
COPY netguard.sh /usr/local/bin/expunge-netguard
ENTRYPOINT ["sh", "/usr/local/bin/expunge-netguard"]
