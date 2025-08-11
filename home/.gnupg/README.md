# GPG Token Access Key Setup

This guide covers creating a dedicated GPG key specifically for token access using `pass` (password store).

## Creating New Token Access Key

### Generate GPG Key

```shell
$ gpg --full-generate-key
$ gpgconf --kill gpg-agent
$ gpg --list-keys --keyid-format LONG
```

## Multi-Machine Setup

```bash
# Export key
$(cd ../../scripts && ./export_gpg_keys KEY_ID)
```

### Import on New Machine

```bash
# Import public key
gpg --import [public-key].asc

# Import private key (from secure backup)
gpg --import [private-key].asc

# Set trust level
gpg --edit-key KEY_ID
gpg> trust
# Choose 5 (ultimate trust)
gpg> save

# Initialize pass
pass init KEY_ID
```

## Links and Resources

- https://dev.to/dnsinyukov/how-to-securely-store-passwords-with-gpg-pass-26d7
- https://bmaingret.github.io/blog/2022-02-15-1Password-gpg-git-seamless-commits-signing




