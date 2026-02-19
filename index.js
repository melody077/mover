// Prompt Mover Extension for SillyTavern
// Allows moving/copying prompts between OpenAI presets
// Uses prompt_order (usage order) for display and insertion

const extensionName = 'prompt-mover';
const GLOBAL_DUMMY_ID = 100001;

// Dynamic imports for third-party compatibility
let getRequestHeaders, callGenericPopup, POPUP_TYPE, openai_setting_names, openai_settings;

async function initImports() {
    const scriptPath = import.meta.url;
    const isThirdParty = scriptPath.includes('/third-party/');
    const base = isThirdParty ? '../../../../' : '../../../';
    
    const scriptModule = await import(base + 'script.js');
    getRequestHeaders = scriptModule.getRequestHeaders;
    
    const popupModule = await import((isThirdParty ? '../../../' : '../../') + 'popup.js');
    callGenericPopup = popupModule.callGenericPopup;
    POPUP_TYPE = popupModule.POPUP_TYPE;
    
    const openaiModule = await import((isThirdParty ? '../../../' : '../../') + 'openai.js');
    openai_setting_names = openaiModule.openai_setting_names;
    openai_settings = openaiModule.openai_settings;
}

let sourcePresetName = '';
let targetPresetName = '';
// These now hold ordered prompt data: [{identifier, enabled, prompt (definition)}]
let sourceOrderedPrompts = [];
let targetOrderedPrompts = [];
let selectedSourcePromptIndex = -1;
let insertPosition = -1; // The exact index to insert at in prompt_order

/**
 * Load all OpenAI presets
 */
async function loadAllPresets() {
    const presets = {};
    
    if (!openai_settings || !openai_setting_names) {
        return presets;
    }
    
    for (const [name, index] of Object.entries(openai_setting_names)) {
        if (openai_settings[index]) {
            presets[name] = openai_settings[index];
        }
    }
    
    return presets;
}

/**
 * Get the prompt_order for the global dummy character from a preset.
 * @param {object} preset
 * @returns {{identifier: string, enabled: boolean}[]}
 */
function getPromptOrder(preset) {
    if (!preset?.prompt_order) return [];
    const entry = preset.prompt_order.find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID));
    return entry?.order || [];
}

/**
 * Find a prompt definition by identifier in a preset's prompts array.
 * @param {object} preset
 * @param {string} identifier
 * @returns {object|null}
 */
function findPromptDef(preset, identifier) {
    return preset?.prompts?.find(p => p.identifier === identifier) || null;
}

/**
 * Build ordered prompt list from prompt_order, resolving each to its definition.
 * Each entry: { identifier, enabled, prompt (full definition or stub) }
 * @param {object} preset
 * @returns {Array}
 */
function getOrderedPrompts(preset) {
    const order = getPromptOrder(preset);
    const prompts = preset?.prompts || [];
    
    return order.map(entry => {
        const def = prompts.find(p => p.identifier === entry.identifier);
        return {
            identifier: entry.identifier,
            enabled: entry.enabled,
            prompt: def || { identifier: entry.identifier, name: entry.identifier },
        };
    });
}

async function savePreset(name, preset) {
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: preset,
        }),
    });
    
    if (!response.ok) {
        throw new Error('Failed to save preset');
    }
    
    return await response.json();
}

function createPopupHtml(presets) {
    const presetOptions = Object.keys(presets)
        .map(name => `<option value="${name}">${name}</option>`)
        .join('');
    
    return `
        <div id="prompt-mover-container">
            <div class="pm-section">
                <div class="pm-section-title">📤 출발 프리셋 (프롬프트 사용 순서)</div>
                <div class="pm-row">
                    <label>프리셋:</label>
                    <select id="pm-source-preset">
                        <option value="">-- 선택 --</option>
                        ${presetOptions}
                    </select>
                </div>
                <div class="pm-prompt-list" id="pm-source-prompts">
                    <div style="padding: 10px; text-align: center;">프리셋을 선택하세요</div>
                </div>
            </div>
            
            <div class="pm-section">
                <div class="pm-section-title">📥 도착 프리셋 - 삽입할 위치를 선택</div>
                <div class="pm-row">
                    <label>프리셋:</label>
                    <select id="pm-target-preset">
                        <option value="">-- 선택 --</option>
                        ${presetOptions}
                    </select>
                </div>
                <div class="pm-prompt-list" id="pm-target-prompts">
                    <div style="padding: 10px; text-align: center;">프리셋을 선택하세요</div>
                </div>
            </div>
            
            <div class="pm-actions">
                <button id="pm-btn-move" disabled>✂️ 이동</button>
            </div>
        </div>
    `;
}

function renderSourceList(container, orderedPrompts, selectedIndex, onSelect) {
    const listElement = container.querySelector('#pm-source-prompts');
    if (!listElement) return;
    
    if (!orderedPrompts || orderedPrompts.length === 0) {
        listElement.innerHTML = '<div style="padding: 10px; text-align: center;">프롬프트 없음</div>';
        return;
    }
    
    listElement.innerHTML = orderedPrompts.map((entry, index) => {
        const isSelected = index === selectedIndex;
        const prompt = entry.prompt;
        const name = prompt.name || prompt.identifier || 'Unnamed';
        const identifier = entry.identifier || '';
        const markerIcon = prompt.marker ? '📍 ' : '';
        return `
            <div class="pm-prompt-item ${isSelected ? 'selected' : ''} ${!entry.enabled ? 'pm-disabled' : ''}" data-index="${index}">
                <span class="pm-prompt-index">#${index + 1}</span>
                <span class="pm-prompt-name">${markerIcon}${name}</span>
                <span class="pm-prompt-identifier">[${identifier}]</span>
            </div>
        `;
    }).join('');
    
    listElement.querySelectorAll('.pm-prompt-item').forEach(item => {
        item.addEventListener('click', () => onSelect(parseInt(item.dataset.index)));
    });
}

function renderTargetListWithSlots(container, orderedPrompts, selectedSlot, onSelectSlot) {
    const listElement = container.querySelector('#pm-target-prompts');
    if (!listElement) return;
    
    if (!orderedPrompts || orderedPrompts.length === 0) {
        listElement.innerHTML = `
            <div class="pm-insert-slot ${selectedSlot === 0 ? 'selected' : ''}" data-slot="0">
                <span class="pm-slot-icon">➕</span> 여기에 삽입
            </div>
        `;
        listElement.querySelector('.pm-insert-slot')?.addEventListener('click', () => onSelectSlot(0));
        return;
    }
    
    let html = '';
    
    // Slot before first item
    html += `<div class="pm-insert-slot ${selectedSlot === 0 ? 'selected' : ''}" data-slot="0">
        <span class="pm-slot-icon">➕</span> 맨 위에 삽입
    </div>`;
    
    orderedPrompts.forEach((entry, index) => {
        const prompt = entry.prompt;
        const name = prompt.name || prompt.identifier || 'Unnamed';
        const identifier = entry.identifier || '';
        const markerIcon = prompt.marker ? '📍 ' : '';
        html += `
            <div class="pm-prompt-item pm-target-item ${!entry.enabled ? 'pm-disabled' : ''}" data-index="${index}">
                <span class="pm-prompt-index">#${index + 1}</span>
                <span class="pm-prompt-name">${markerIcon}${name}</span>
                <span class="pm-prompt-identifier">[${identifier}]</span>
            </div>
        `;
        
        // Slot after each item
        const slotIdx = index + 1;
        html += `<div class="pm-insert-slot ${selectedSlot === slotIdx ? 'selected' : ''}" data-slot="${slotIdx}">
            <span class="pm-slot-icon">➕</span> 여기에 삽입
        </div>`;
    });
    
    listElement.innerHTML = html;
    
    listElement.querySelectorAll('.pm-insert-slot').forEach(slot => {
        slot.addEventListener('click', () => onSelectSlot(parseInt(slot.dataset.slot)));
    });
}

function updateButtons(container) {
    const moveBtn = container.querySelector('#pm-btn-move');
    
    const canMove = sourcePresetName && targetPresetName && 
                    selectedSourcePromptIndex >= 0 && insertPosition >= 0 &&
                    sourcePresetName !== targetPresetName;
    
    if (moveBtn) moveBtn.disabled = !canMove;
}

async function performOperation(container, removeFromSource) {
    if (selectedSourcePromptIndex < 0 || insertPosition < 0) {
        toastr.error('프롬프트와 삽입 위치를 선택해주세요');
        return;
    }
    
    const sourceSettingIndex = openai_setting_names[sourcePresetName];
    const targetSettingIndex = openai_setting_names[targetPresetName];
    
    if (sourceSettingIndex === undefined || targetSettingIndex === undefined) {
        toastr.error('프리셋을 찾을 수 없습니다');
        return;
    }
    
    const selectedEntry = sourceOrderedPrompts[selectedSourcePromptIndex];
    if (!selectedEntry) {
        toastr.error('선택한 프롬프트를 찾을 수 없습니다');
        return;
    }
    
    // Deep copy the prompt definition to insert
    const promptDef = JSON.parse(JSON.stringify(selectedEntry.prompt));
    
    // Handle duplicate identifiers in target
    const targetPreset = JSON.parse(JSON.stringify(openai_settings[targetSettingIndex]));
    targetPreset.prompts = targetPreset.prompts || [];
    targetPreset.prompt_order = targetPreset.prompt_order || [];
    
    const existingIds = targetPreset.prompts.map(p => p.identifier);
    let newIdentifier = promptDef.identifier;
    if (existingIds.includes(newIdentifier)) {
        let counter = 1;
        const baseName = newIdentifier.replace(/_\d+$/, '');
        while (existingIds.includes(`${baseName}_${counter}`)) counter++;
        newIdentifier = `${baseName}_${counter}`;
        promptDef.identifier = newIdentifier;
        promptDef.name = `${promptDef.name || selectedEntry.identifier} (${counter})`;
    }
    
    // Add prompt definition to target's prompts array (at the end)
    targetPreset.prompts.push(promptDef);
    
    // Insert into prompt_order at the selected position
    const targetOrderEntry = targetPreset.prompt_order.find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID));
    if (targetOrderEntry && targetOrderEntry.order) {
        targetOrderEntry.order.splice(insertPosition, 0, { identifier: newIdentifier, enabled: true });
    } else {
        // If no global order entry exists, create one
        targetPreset.prompt_order.push({
            character_id: GLOBAL_DUMMY_ID,
            order: [{ identifier: newIdentifier, enabled: true }],
        });
    }
    
    // Also insert into any character-specific prompt_orders
    for (const orderEntry of targetPreset.prompt_order) {
        if (String(orderEntry.character_id) !== String(GLOBAL_DUMMY_ID) && orderEntry.order) {
            orderEntry.order.push({ identifier: newIdentifier, enabled: true });
        }
    }
    
    try {
        await savePreset(targetPresetName, targetPreset);
        openai_settings[targetSettingIndex] = targetPreset;
        
        if (removeFromSource && sourcePresetName !== targetPresetName) {
            const sourcePreset = JSON.parse(JSON.stringify(openai_settings[sourceSettingIndex]));
            const removedId = selectedEntry.identifier;
            
            // Remove from source's prompts array
            const promptIdx = sourcePreset.prompts.findIndex(p => p.identifier === removedId);
            if (promptIdx >= 0) {
                sourcePreset.prompts.splice(promptIdx, 1);
            }
            
            // Remove from all prompt_order entries
            if (sourcePreset.prompt_order) {
                for (const order of sourcePreset.prompt_order) {
                    if (order.order) {
                        order.order = order.order.filter(o => o.identifier !== removedId);
                    }
                }
            }
            
            await savePreset(sourcePresetName, sourcePreset);
            openai_settings[sourceSettingIndex] = sourcePreset;
        }
        
        toastr.success(removeFromSource ? '이동 완료' : '복사 완료');
        
        // Refresh lists
        sourceOrderedPrompts = getOrderedPrompts(openai_settings[sourceSettingIndex]);
        targetOrderedPrompts = getOrderedPrompts(openai_settings[targetSettingIndex]);
        selectedSourcePromptIndex = -1;
        insertPosition = -1;
        
        const srcHandler = idx => {
            selectedSourcePromptIndex = idx;
            renderSourceList(container, sourceOrderedPrompts, idx, srcHandler);
            updateButtons(container);
        };
        const slotHandler = slot => {
            insertPosition = slot;
            renderTargetListWithSlots(container, targetOrderedPrompts, slot, slotHandler);
            updateButtons(container);
        };
        
        renderSourceList(container, sourceOrderedPrompts, -1, srcHandler);
        renderTargetListWithSlots(container, targetOrderedPrompts, -1, slotHandler);
        updateButtons(container);
        
    } catch (error) {
        console.error('Operation error:', error);
        toastr.error('작업 실패');
    }
}

async function openPromptMoverPopup() {
    try {
        const presets = await loadAllPresets();
        
        if (Object.keys(presets).length === 0) {
            toastr.warning('프리셋이 없습니다. Chat Completion API를 사용 중인지 확인하세요.');
            return;
        }
        
        // Reset state
        sourcePresetName = '';
        targetPresetName = '';
        sourceOrderedPrompts = [];
        targetOrderedPrompts = [];
        selectedSourcePromptIndex = -1;
        insertPosition = -1;
        
        const container = document.createElement('div');
        container.innerHTML = createPopupHtml(presets);
        
        const srcHandler = idx => {
            selectedSourcePromptIndex = idx;
            renderSourceList(container, sourceOrderedPrompts, idx, srcHandler);
            updateButtons(container);
        };
        
        const slotHandler = slot => {
            insertPosition = slot;
            renderTargetListWithSlots(container, targetOrderedPrompts, slot, slotHandler);
            updateButtons(container);
        };
        
        container.querySelector('#pm-source-preset')?.addEventListener('change', e => {
            sourcePresetName = e.target.value;
            selectedSourcePromptIndex = -1;
            sourceOrderedPrompts = sourcePresetName ? getOrderedPrompts(openai_settings[openai_setting_names[sourcePresetName]]) : [];
            renderSourceList(container, sourceOrderedPrompts, -1, srcHandler);
            updateButtons(container);
        });
        
        container.querySelector('#pm-target-preset')?.addEventListener('change', e => {
            targetPresetName = e.target.value;
            insertPosition = -1;
            targetOrderedPrompts = targetPresetName ? getOrderedPrompts(openai_settings[openai_setting_names[targetPresetName]]) : [];
            renderTargetListWithSlots(container, targetOrderedPrompts, -1, slotHandler);
            updateButtons(container);
        });
        
        container.querySelector('#pm-btn-move')?.addEventListener('click', () => performOperation(container, true));
        
        await callGenericPopup(container, POPUP_TYPE.TEXT, '', { okButton: '닫기', cancelButton: false, wide: true });
        
    } catch (error) {
        console.error('Popup error:', error);
        toastr.error('Prompt Mover를 열 수 없습니다');
    }
}

function addExtensionPanel() {
    const tryAdd = () => {
        if (document.getElementById('prompt_mover_container')) return true;
        
        const settingsPanel = document.getElementById('extensions_settings2');
        if (!settingsPanel) return false;
        
        const container = document.createElement('div');
        container.id = 'prompt_mover_container';
        container.className = 'extension_container';
        container.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Mover</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p style="margin: 5px 0;">프리셋 간에 프롬프트를 복사/이동합니다.</p>
                    <div id="pm-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-arrows-left-right"></i>
                        <span>Prompt Mover 열기</span>
                    </div>
                </div>
            </div>
        `;
        container.querySelector('#pm-open-btn').addEventListener('click', openPromptMoverPopup);
        settingsPanel.appendChild(container);
        return true;
    };
    
    if (tryAdd()) return;
    
    // Retry with interval
    let count = 0;
    const timer = setInterval(() => {
        if (tryAdd() || ++count > 50) clearInterval(timer);
    }, 200);
}

function addPromptManagerButton() {
    const tryAdd = () => {
        if (document.getElementById('pm-header-btn')) return;
        const header = document.querySelector('#completion_prompt_manager_header');
        if (!header) return;
        
        const btn = document.createElement('div');
        btn.id = 'pm-header-btn';
        btn.className = 'menu_button menu_button_icon';
        btn.title = 'Prompt Mover';
        btn.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i>';
        btn.style.marginLeft = '5px';
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPromptMoverPopup(); });
        header.appendChild(btn);
    };
    
    tryAdd();
    
    const observer = new MutationObserver(tryAdd);
    observer.observe(document.body, { childList: true, subtree: true });
}

// Init
jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        await initImports();
        addExtensionPanel();
        addPromptManagerButton();
        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
