# Release Pipeline Consistency Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans.

**Goal:** Make the existing tag-triggered release own one coherent tarball/ZIP/checksum family, preserving older tags and current release notes.
**Architecture:** Existing Release workflow uses the maintained bundle builder when present at the selected tag; older tags retain a library-only fallback. Smoke-test the actual portable payload offline before upload. Serialize per-tag publishers; newly created releases stay draft until all upload succeeds.
**Tech Stack:** Existing GitHub Actions, Node/npm, Pythonstdlib, nativeNode process tests. No permissions/dependencies/API/version/tag changes.
**Spec:** Root cause: manual macOS/npm11 tarball and automatic Ubuntu/Node22 tarball had identical ten unpacked files but different compression envelopes. Existing release.yml uploaded with clobber after the independent ZIP/checksum upload. Public verification caught inconsistent byte hashes. v0.2.0 temporarily drafted; its591c826 source/tag remains unchanged. Single pipeline build must own all artifacts. Standing shipping authorization covers repair.

## Task 1: Behavioral pipeline regression and workflow repair

Files: .github/workflows/release.yml, test/release-artifacts.test.js, package.json, .github/workflows/ci.yml, docs/RELEASING.md.
Interfaces: actual Pack the tarball/Write checksums/Smoke-test portable shell blocks -> tagged-source fixture and one coherent family. Current tags withbuilder produce standalone/nestedidenticaltgz, ZIP and matching SHA256SUMS/legacySHA256SUMS.txt. Builderabsent tags retainlibraryonly TGZ+legacychecksum.

- [ ] Execute real existingworkflow shellblocks in isolatedgitarchive source copies. Expected RED: currenttagartifactfamily lacksZIP/newchecksum (legacycontrol retained wherehost supportsoriginalGNUutility).
- [ ] Delegate packing to existingbuilder once, retainlegacyfallback, copycanonicalchecksums tolegacyalias, smoketestactualportableofflinefourcommands/expected3, serializeper-tagpublication and create-newdraft/upload/promote. Preserveexistingdraftstate/notes. Expected: bothactualnativeprocess cases pass, no runtime/source/tag mutation.
- [ ] Wire nativepipelinecheck to npmcheck/Node20/22/24CI, documentpipelineownership; lint/format/type andallpackage/pipelinechecks pass. Commit; finaltaskcommandnpmruntest:release.
- [ ] One fresh independentexact-headreview, greenmerge. Dispatch currentmainworkflow against existingimmutablev0.2tag. Readjobs throughGitHubtools. Waitforcanonicalpipelinecompletion, publishdraft, actualpublicdownload/hash/nestedparity/emptycacheconsumerproof thenfinish. No manual tarball replacement or oldtag alteration.

## Review Focus

Legacytagswithoutbuilder; shellargumentquoting; checkedtagversusworkflowsource; coherentfixedfamily/noextra privatefiles; version/checksumaliases; actualofflineartifactsmoke; existingdraft/notes preservation; no token/permissions expansion; pertagpublisherconcurrency and source/tagimmutability.
