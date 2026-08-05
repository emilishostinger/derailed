# hello-dockerfile

Fixture repository for the deploy pipeline integration test. The test copies this
folder into a temporary directory, turns it into a git repository, and deploys it -
so the whole pipeline runs without touching the network beyond the alpine base image.
