@echo off
"C:\Program Files\PuTTY\plink.exe" -ssh -batch -N -L 54086:127.0.0.1:53844 -P 22 -l gcase -hostkey "ssh-ed25519 255 SHA256:q7mcJF1J1jFaeJApFOUSTW4y9IWjk3h7xt4MKXT4RJM" -pw "Kal!\"12345.12345" 192.168.1.27
