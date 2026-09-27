FROM node:24-bookworm

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs
COPY fly/tools/qm-edge /usr/local/bin/qm-edge
RUN chmod +x /usr/local/bin/qm-edge

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
