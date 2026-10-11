const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function uploadToGumroad() {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    
    // Navigate to Gumroad login page first
    await page.goto('https://gumroad.com/login');
    
    // TODO: Add login credentials (manual or automated)
    // This would need to be filled in based on actual login requirements
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Load upload map to understand what files need to be uploaded
    const uploadMapPath = process.env.MAP || path.join(__dirname, '..', 'upload_map.json');
    const uploadMap = JSON.parse(fs.readFileSync(uploadMapPath, 'utf8'));
    
    console.log(`Found ${uploadMap.length} products to process`);
    
    // For each product, we need to:
    // 1. Navigate to the correct product edit page (would need to iterate through all products)
    // 2. Find the file input selectors for thumbnail and content uploads
    // 3. Upload the corresponding files
    
    // For now, demonstrate with the first product
    const firstProduct = uploadMap[0];
    console.log(`Processing product: ${firstProduct.gumroad_name}`);
    console.log(`Slug: ${firstProduct.slug}`);
    
    // Find file input selectors - we'll need to inspect the page structure
    // Common selectors might be:
    // - File inputs with type="file"
    // - Inputs with specific data-test-id or aria-label attributes
    
    // Try to locate the thumbnail upload input
    try {
        // Look for file input elements
        const fileInputs = await page.$$('input[type="file"]');
        console.log(`Found ${fileInputs.length} file input elements`);
        
        // Try to identify which input is for thumbnail vs content
        // This would need to be determined from the page structure
        for (let i = 0; i < fileInputs.length; i++) {
            const input = fileInputs[i];
            const name = await input.getAttribute('name') || '';
            const id = await input.getAttribute('id') || '';
            const ariaLabel = await input.getAttribute('aria-label') || '';
            const accept = await input.getAttribute('accept') || '';
            const parent = await input.evaluate(el => el.parentElement);
            const sectionTitle = parent ? parent.textContent.trim().split('\n')[0] || '' : '';
            console.log(`Input ${i}: name=${name}, id=${id}, accept=${accept}, aria-label=${ariaLabel}, section=${sectionTitle}`);
        }
    } catch (error) {
        console.error('Error finding file inputs:', error);
    }
    
    // Inspect DOM structure to understand upload sections better
    const uploadAnalysis = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        return inputs.map((input, index) => {
            const parent = input.parentElement;
            const grandparent = parent?.parentElement;
            const section = input.closest('section, article, main, div[class*="upload"], div[class*="form"]');
            
            return {
                index: index,
                name: input.name || '',
                accept: input.accept || '',
                parentTag: parent?.tagName || '',
                parentClass: parent?.className || '',
                grandparentTag: grandparent?.tagName || '',
                sectionClass: section?.className || '',
                sectionText: section?.textContent?.trim().split('\n')[0] || ''
            };
        });
    });
    
    console.log('\n=== Upload Analysis ===');
    uploadAnalysis.forEach(item => {
        console.log(`File Input ${item.index}:`);
        console.log(`  Name: ${item.name}`);
        console.log(`  Accept: ${item.accept}`);
        console.log(`  Section: ${item.sectionText}`);
        console.log(`  Section Class: ${item.sectionClass}`);
        console.log(`  Parent Class: ${item.parentClass}`);
        console.log();
    });
    
    // Now we can use the analysis to determine selectors for uploads
    console.log('\n=== Determining Upload Strategies ===');
    
    // Identify thumbnail upload based on accept parameter and section text
    const thumbnailInputs = uploadAnalysis.filter(item => 
        item.accept.includes('image') || 
        item.sectionText.toLowerCase().includes('thumbnail') ||
        item.sectionText.toLowerCase().includes('upload')
    );
    
    // Identify content/zip upload based on file size, acceptance, or section
    const contentInputs = uploadAnalysis.filter(item =>
        item.accept.includes('zip') ||
        item.accept.includes('tar') ||
        item.accept.includes('compressed') ||
        item.sectionText.toLowerCase().includes('content') ||
        item.sectionText.toLowerCase().includes('main')
    );
    
    console.log('Thumbnail upload candidates:', thumbnailInputs.length);
    console.log('Content upload candidates:', contentInputs.length);
    
    // Based on typical Gumroad structure, we'll use the first input with image acceptance as thumbnail
    // and the first input without image acceptance as content
    let thumbnailSelector = 'input[type="file"][accept*=".jpeg,.jpg,.png,.gif,.webp,image/avif"]';
    let contentSelector = 'input[type="file"]:not([accept*=".jpeg,.jpg,.png,.gif,.webp,image/avif"])';
    
    console.log('\n=== Proposed Selectors ===');
    console.log('Thumbnail Selector:', thumbnailSelector);
    console.log('Content Selector:', contentSelector);
    
    // For demonstration, let's try to interact with the thumbnail input
    try {
        // Get all file inputs
        const allInputs = await page.$$('input[type="file"]');
        console.log(`Found ${allInputs.length} file input elements for interaction`);
        
        // Find the thumbnail input (usually the one with image accept types)
        let thumbnailInput = null;
        for (let input of allInputs) {
            const accept = await input.getAttribute('accept') || '';
            if (accept.includes('jpeg') || accept.includes('jpg') || accept.includes('png') || 
                accept.includes('gif') || accept.includes('webp') || accept.includes('avif')) {
                thumbnailInput = input;
                break;
            }
        }
        
        if (thumbnailInput) {
            console.log('✓ Found thumbnail input');
            console.log('  Accept types:', await thumbnailInput.getAttribute('accept'));
            console.log('  Parent class:', await thumbnailInput.evaluate(el => el.parentElement?.className));
        } else {
            console.log('✗ No thumbnail input found');
        }
        
        // Find content input (usually the zip file upload)
        let contentInput = null;
        for (let input of allInputs) {
            const accept = await input.getAttribute('accept') || '';
            if (accept.includes('zip') || accept.includes('tar') || !accept.includes('image')) {
                if (input !== thumbnailInput) {
                    contentInput = input;
                    break;
                }
            }
        }
        
        if (contentInput) {
            console.log('✓ Found content input');
            console.log('  Accept types:', await contentInput.getAttribute('accept'));
        } else {
            console.log('✗ No content input found');
        }
        
    } catch (error) {
        console.error('Error during interaction testing:', error);
    }
    
    // Take a screenshot to see the current state
    await page.screenshot({ path: '/tmp/current-state.png' });
    
    await browser.close();
    
    console.log('Upload process completed (partial implementation)');
}

// Run the function
uploadToGumroad().catch(console.error);