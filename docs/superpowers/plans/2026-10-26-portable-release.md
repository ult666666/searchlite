# Portable Local Review Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans.

**Goal:** Deliver release0.2.0 and an offline-installable actuallocalreviewexample withoutconsumerbuilddependencies.
**Architecture:** Pythonstdlib maintainerbuilder runs existingfreshnpm pack offline, copies an explicit publicsourcewhitelist and creates hashed fixedmetadataZIP. Existinglibrary/CLI semantics unchanged.
**Tech Stack:** Node20+ consumer, Python3/npm maintainer, nativeNode tests, existingCI.
**Spec:** docs/superpowers/specs/2026-10-26-portable-release-design.md

## Global Constraints

No npmregistrypublish/dependencies/providers/networkpurchase. Existing v0.1 preserved; onlynew0.2tag. Newoutputonly, whitelistonly, no user/privateglob. Builder120secondnpmdeadline, tempcleanup, no partialstdout or existingoverwrite; consumerNodeonly/offline/ignore-scripts. Recordexactbytes, notauthorship.

## Review Focus

Outputexisting/brokenlinks/missingparent mustnot mutatefiles. Archive mustcontainonlyregularrelativewhitelistedpayload, withcorrectmanifest andlocaldependency. Offlineinstallmustworkwithemptycache andnoruntime/devtransitives. Guidecommands mustexerciseactualbuiltCLI andexpected3failures. Package/version/lock/changelog/source/mergedtag/assets mustagreewithoutclaiming npmregistrypublication.

## Task 1: Maintained portable bundle and native process checks

Files: create scripts/package_local_review.py and test/local-package.test.js; package.json package-lock.json .github/workflows/ci.yml.
Interfaces: npm pack existingprepack yieldsfreshversionedtgz; sourceCLI/guides/fixtures→exactZIPpayload; test/nativeCI verifies installedpackage+consumer.

- [ ] Write nativeprocess tests first, runnode --test; Expected: missingbuilder RED.
- [ ] Implement minimalbuilder andversion0.2 metadata, explicitCLI/usefulREADME/manifest; wiretest:package/npmcheck/NodeCI; format. Run actualnative tests; Expected: allgreenincludingempty-cache offline fourcommands/control/refusal.
- [ ] Run npmruncheck andbrowser/eval; Expected: existing266/6native plusnewpackagechecks green. Commit; finaltaskcommand npmrun test:package.

## Task 2: Release documentation and verified shipping

Files: docs/RELEASING.md,README.md,CHANGELOG.md.
Interfaces: exactbuilder/consumer outputs→releaserecipe and three newGitHubassets; sourceversion0.2→immutabletag.

- [ ] Documentreproduciblebuilder/newdest/offlinequickstart/limits; moveactualUnreleased featuresto0.2.0date andtruthfulsourceconsumercoverage. Format; actualrecipealreadyexercised bynativeprocess tests. Commit; finalcommandnpmrunformat:check.
- [ ] One independentwholebranchreview, exactgreenmerge, freshmergedsourcebundle/build/publicassets; publishnew0.2release withthreeactualassets, then download/byteverify/extract/offlineinstall/CLIproof beforecompletion. Retainprevioussource/checkpoints/releases.
