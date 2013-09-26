" Modeline and Notes {
" vim: set foldmarker={,} foldlevel=0 foldmethod=marker spell:
"   This .vimrc is largely inspired by
"   https://github.com/spf13/spf13-vim/blob/master/.vimrc and
"   https://github.com/kmckelvin/vimrc/blob/master/vimrc
" }

" Environment {
  " Basics {
    set nocompatible " must come first
    set background=dark " assume a dark background
  "}
"}

" Bundles {
  set rtp+=~/.vim/bundle/vundle/
  call vundle#rc()
  Bundle 'gmarik/vundle'

  Bundle 'rking/ag.vim'
  Bundle 'vim-ruby/vim-ruby'
  Bundle 'tpope/vim-rails'
  Bundle 'tpope/vim-fugitive'
  Bundle 'tpope/vim-surround'
  Bundle 'Raimondi/delimitMate'
  Bundle 'adamlowe/vim-slurper'
  Bundle 'kien/ctrlp.vim'
  Bundle 'slim-template/vim-slim'
  Bundle 'ervandew/supertab'
  Bundle 'kchmck/vim-coffee-script'
  Bundle 'ddollar/nerdcommenter'
  Bundle 'tpope/vim-endwise'
  Bundle 'ecomba/vim-ruby-refactoring'
  Bundle 'scrooloose/syntastic'
  Bundle 'scrooloose/nerdtree'
  Bundle 'shawncplus/phpcomplete.vim'
  Bundle 'godlygeek/tabular'
  Bundle 'majutsushi/tagbar'
  Bundle 'Lokaltog/powerline', {'rtp': 'powerline/bindings/vim/'}
  Bundle 'jistr/vim-nerdtree-tabs'
  Bundle 'terryma/vim-multiple-cursors'
  Bundle 'guns/vim-clojure-static'
  Bundle 'tpope/vim-fireplace'
  Bundle 'jwhitley/vim-matchit'
  Bundle 'joonty/vdebug.git'
  Bundle 'mattn/emmet-vim'
"}

" General {
  filetype plugin indent on " automatically detect files types
  syntax on                 " syntax highlighting
  set mouse=a               " automatically enable mouse usage
  scriptencoding utf-8
  set history=1000          " store more history (default is 20)
  set nospell               " spell checking off
  set noswapfile            " don't use swapfiles

  " don't create backup files
  set nobackup
  set nowritebackup

  " remove the delay when hitting esc in insert mode
  set noesckeys
  set ttimeout
  set ttimeoutlen=1

  " check for external file changes
  if has("autocmd")
    autocmd CursorHold,CursorMoved,BufEnter * checktime
  endif

  if has('mouse_sgr')
    set ttymouse=sgr
  endif
" }

" Vim UI {
  color monokai                                   " load a colourscheme
  set splitright                                  " open split panes to the right of the current pane
  set splitbelow                                  " open split panes underneath the current pane

  set cursorline                                  " highlight current line
  hi CursorLine term=bold cterm=bold ctermbg=233

  set colorcolumn=85                              " show column length hint for long lines

  set backspace=indent,eol,start                  " allow backspacing over everything in insert mode
  set linespace=0                                 " No extra spaces between rows
  set relativenumber                              " relative line numbers on
  set showmatch                                   " show matching brackets/parenthesis
  set incsearch                                   " find as you type search
  set hlsearch                                    " highlight search terms
  set winminheight=0                              " windows can be 0 line high
  set ignorecase                                  " case insensitive search
  set smartcase                                   " case sensitive when uc present
  set wildmenu                                    " show list instead of just completing
  set wildmode=list:longest,full                  " command <Tab> completion, list matches, then longest common part, then all.
  set scrolljump=5                                " lines to scroll when cursor leaves screen
  set scrolloff=5                                 " minimum lines to keep above and below cursor
  noh                                             " clear the initial highlight after sourcing
  set foldenable                                  " auto fold code
  set nospell                                     " disable spellcheck
  set shortmess=atI                               " prevent 'Press ENTER' prompt

  " highlight trailing white space
  highlight ExtraWhitespace ctermbg=red guibg=red
  match ExtraWhitespace /\s\+$/

  " switch relative line numbers to absolute when Vim is not in focus
  :au FocusLost * :set number
  :au FocusGained * :set relativenumber

  " use absolute numbers when in Insert mode
  autocmd InsertEnter * :set number
  autocmd InsertLeave * :set relativenumber

  " show timeout on leader
  set showcmd

  " show wildmenu when pressing <Tab> to autocomplete command line hints
  set wildmenu
  set wildmode=longest,list

  " change cursor to caret when in insert mode, block in other modes
  let &t_SI = "\<Esc>]50;CursorShape=1\x7"
  let &t_EI = "\<Esc>]50;CursorShape=0\x7"
" }

" Formatting {
  set wrap                                                   " wrap long lines
  set autoindent                                             " indent at the same level of the previous line
  set shiftwidth=2                                           " use indents of 2 spaces
  set expandtab                                              " expand tabs to spaces
  set tabstop=2                                              " indent every 2 columns
  set softtabstop=2                                          " let backspace delete indent
  autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2 et " set above values when opening new files
" }

" Key Mappings {
  " set custom leader
  let mapleader = ','

  " navigate panes with <c-hhkl>
  nmap <silent> <c-k> :wincmd k<CR>
  nmap <silent> <c-j> :wincmd j<CR>
  nmap <silent> <c-h> :wincmd h<CR>
  nmap <silent> <c-l> :wincmd l<CR>

  " j and k navigate through wrapped lines
  nmap k gk
  nmap j gj

  " map common shift keys
  cmap Q q " Bind :Q to :q
  cmap Qall qall
  cmap W w
  cmap Wa wall
  cmap Tabe tabe

  " yank from cursor to EOL the same as C and D do
  nnoremap Y y$

  " code folding options
  nmap <leader>f0 :set foldlevel=0<CR>
  nmap <leader>f1 :set foldlevel=1<CR>
  nmap <leader>f2 :set foldlevel=2<CR>
  nmap <leader>f3 :set foldlevel=3<CR>
  nmap <leader>f4 :set foldlevel=4<CR>
  nmap <leader>f5 :set foldlevel=5<CR>
  nmap <leader>f6 :set foldlevel=6<CR>
  nmap <leader>f7 :set foldlevel=7<CR>
  nmap <leader>f8 :set foldlevel=8<CR>
  nmap <leader>f9 :set foldlevel=9<CR>

  " clear highlighted searches
  nmap <silent> <leader>/ :nohlsearch<CR>

  " use enter in normal mode to create lines above and below the cursor
  noremap <S-ENTER> O<ESC>j
  noremap <ENTER> o<ESC>k

  " visual shifting without exiting visual mode
  vnoremap < <gv
  vnoremap > >gv

  " quickly move lines up and down
  nnoremap <A-J> :m .+1<CR>==
  nnoremap <A-K> :m .-2<CR>==
  inoremap <A-J> <Esc>:m .+1<CR>==gi
  inoremap <A-K> <Esc>:m .-2<CR>==gi
  vnoremap <A-J> :m '>+1<CR>gv=gv
  vnoremap <A-K> :m '<-2<CR>gv=gv

  " Emacs-like beginning and end of line
  imap <c-e> <c-o>$
  imap <c-a> <c-o>^

  " paste, fix indentation and clear the mark by default
  nnoremap p p=`]`<esc>

  " clear trailing white space across file
  nnoremap <leader>T :%s/\s\+$//<cr>:let @/=''<CR>

  " quickly move to next and previous buffers
  map <leader>bn :bn<CR>
  map <leader>bp :bp<CR>

  " quick access to this .vimrc
  map <leader>vi :tabe ~/dotfiles/.vimrc<CR>
  map <leader>vs :source ~/.vimrc<CR>

" }

" Plugins {

  " Vundle {
    " Update / Install bundles
    map <leader>vbi :BundleInstall<CR>
    map <leader>vbu :BundleUpdate<CR>
  " }

  " ctrlP {
    let g:ctrlp_max_height = 25
    let g:ctrlp_show_hidden = 1
  " }

  " delimitMate {
    let delimitMate_expand_cr = 1
    let delimitMate_expand_space = 1
  " }

  " Fugitive {
    " git push
    nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>

    " git push to heroku
    nmap <leader>ghp :exec ':Git push heroku ' . fugitive#head()<CR>

    " git status
    map <silent> <leader>gs :Gstatus<CR>/not staged<CR>/modified<CR>

    " git commit -am "
    map <leader>gci :Git commit -am "

    " git checkout
    map <leader>gco :Git checkout

    " git diff
    map <leader>gd :Gdiff<CR>

    " git gui
    map <leader>ggui :Git gui<CR>
    map <leader>gw :!git add . && git commit -m "WIP"

  " }

  " NERDTree {
    " quick access to NERDTree
    map <leader>n :NERDTreeTabsToggle<CR>
    map <leader>ff :NERDTreeFind<CR>

    " open NERDTree on startup
    let g:nerdtree_tabs_open_on_console_startup = 1

    " show hidden files by default
    let NERDTreeShowHidden=1
  " }

  " Syntastic {
    let g:syntastic_check_on_open=1
  " }

  " Powerline {
    let g:Powerline_symbols = 'fancy'
  " }

  " Tabularize {
    if exists(":Tabularize")
      " align equal signs in normal and visual mode
      nmap <Leader>a= :Tabularize /=<CR>
      vmap <Leader>a= :Tabularize /=<CR>

      " align colons in normal and visual mode
      nmap <Leader>a: :Tabularize /:\zs<CR>
      vmap <Leader>a: :Tabularize /:\zs<CR>
    endif
  " }

  " The Silver Searcher {
    " Source: https://github.com/thoughtbot/dotfiles/blob/master/vimrc
    if executable('ag')
      " Use Ag over Grep
      set grepprg=ag\ --nogroup\ --nocolor

      " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
      let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'
    endif
  " }
" }

nmap <leader>bx :!bundle exec<space>
nmap <leader>zx :!zeus<space>

map <leader>bi :!bundle<CR>
map <leader>bu :!bundle update<space>

map <leader>= <C-w>=

map <leader>rt :call RunCurrentTest()<CR>
map <leader>rl :call RunCurrentLineInTest()<CR>
map <leader>rrt :call RunCurrentTestNoZeus()<CR>
map <leader>rrl :call RunCurrentLineInTestNoZeus()<CR>

map <leader>sm :RSmodel<space>
map <leader>vc :RVcontroller<CR>
map <leader>vm :RVmodel<space>
map <leader>vv :RVview<CR>
map <leader>zv :Rview<CR>
map <leader>zc :Rcontroller<CR>
map <leader>zm :Rmodel<space>

" pane management
map <leader>mh :wincmd H<CR>
map <leader>mj :wincmd J<CR>
map <leader>mk :wincmd K<CR>
map <leader>ml :wincmd L<CR>

" restart pow
map <leader>rp :!touch tmp/restart.txt<CR><CR>

" select the current method in ruby (or it block in rspec)
map <leader>sm /end<CR>?\<def\>\\|\<it\><CR>:noh<CR>V%
map <leader>sf :e spec/factories/

" deprecated? must check new docs.
autocmd User Rails Rnavcommand presenter app/presenters -glob=**/* -suffix=.rb

" Set up some useful Rails.vim bindings for working with Backbone.js
autocmd User Rails Rnavcommand template    app/assets/templates               -glob=**/*  -suffix=.jst.ejs
autocmd User Rails Rnavcommand jmodel      app/assets/javascripts/models      -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jview       app/assets/javascripts/views       -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jcollection app/assets/javascripts/collections -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jrouter     app/assets/javascripts/routers     -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jspec       spec/javascripts                   -glob=**/*  -suffix=.coffee


if has("autocmd")
  " Also load indent files, to automatically do language-dependent indenting.

  " Put these in an autocmd group, so that we can delete them easily.
  augroup vimrcEx
  au!

  " For all text files set 'textwidth' to 78 characters.
  autocmd FileType text setlocal textwidth=78

  " Never wrap slim files
  autocmd FileType slim setlocal textwidth=0

  " Delete trailing shite space on save
  autocm BufWritePre * :%s/\s\+$//e

  " When editing a file, always jump to the last known cursor position.
  " Don't do it when the position is invalid or when inside an event handler
  " (happens when dropping a file on gvim).
  autocmd BufReadPost *
    \ if line("'\"") > 0 && line("'\"") <= line("$") |
    \   exe "normal g`\"" |
    \ endif

  augroup END

endif " has("autocmd")

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" Test-running stuff, thanks @r00k!
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! RunCurrentTest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFile()

    if match(expand('%'), '\.feature$') != -1
      call SetTestRunner("!zeus cucumber")
      exec g:bjo_test_runner g:bjo_test_file
    elseif match(expand('%'), '_spec\.rb$') != -1
      call SetTestRunner("!zeus rspec")
      exec g:bjo_test_runner g:bjo_test_file
    else
      call SetTestRunner("!ruby -Itest")
      exec g:bjo_test_runner g:bjo_test_file
    endif
  else
    exec g:bjo_test_runner g:bjo_test_file
  endif
endfunction

function! RunCurrentTestNoZeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1

  if in_test_file
    call SetTestFile()
  endif

  exec "!rspec" g:bjo_test_file
endfunction

function! RunCurrentLineInTestNoZeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFileWithLine()
  end

  exec "!rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! SetTestRunner(runner)
  let g:bjo_test_runner=a:runner
endfunction

function! RunCurrentLineInTest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFileWithLine()
  end

  exec "!zeus rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! SetTestFile()
  let g:bjo_test_file=@%
endfunction

function! SetTestFileWithLine()
  let g:bjo_test_file=@%
  let g:bjo_test_file_line=line(".")
endfunction
