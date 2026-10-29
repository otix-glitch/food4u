const baseProducts = [
	{
		name: 'District Heavy Tee', price: 42, category: 'tops', detail: 'Tops · Chalk',
		image: '/assets/products/photo-1521572163474-6864f9cf17ab.jpg',
		imageAlt: 'Heavyweight white cotton T-shirt', tag: 'Bestseller'
	},
	{
		name: 'After Hours Denim', price: 88, category: 'bottoms', detail: 'Bottoms · Washed black',
		image: '/assets/products/photo-1542272604-787c3835535d.jpg',
		imageAlt: 'Relaxed dark denim jeans', tag: 'New'
	},
	{
		name: 'Block Party Jacket', price: 124, category: 'tops', detail: 'Outerwear · Burnt orange',
		image: '/assets/products/photo-1551028719-00167b16eac5.jpg',
		imageAlt: 'Relaxed vintage-inspired outerwear', tag: 'Limited run'
	},
	{
		name: 'Off Script Cap', price: 36, category: 'extras', detail: 'Extras · Washed olive',
		image: '/assets/products/photo-1521369909029-2afed882baee.jpg',
		imageAlt: 'Classic everyday baseball cap', tag: 'Easy fit'
	},
	{
		name: 'Sunday State Sweatshirt', price: 76, category: 'tops', detail: 'Tops · Heather grey',
		image: '/assets/products/photo-1551488831-00ddcb6c6bd3.jpg',
		imageAlt: 'Soft everyday sweatshirt', tag: 'Just landed'
	},
	{
		name: 'All Day Trousers', price: 72, category: 'bottoms', detail: 'Bottoms · Everyday khaki',
		image: '/assets/products/photo-1515886657613-9f3515b0c78f.jpg',
		imageAlt: 'Easy relaxed-fit everyday trousers', tag: 'Easy fit'
	},
	{
		name: 'Side Street Long Sleeve', price: 54, category: 'tops', detail: 'Tops · Soft white',
		image: '/assets/products/photo-1620799140408-edc6dcb6d633.jpg',
		imageAlt: 'Relaxed-fit graphic tee', tag: 'District pick'
	},
	{
		name: 'Daily Loop Bag', price: 64, category: 'extras', detail: 'Extras · Cobalt',
		image: '/assets/products/photo-1553062407-98eeb64c6a62.jpg',
		imageAlt: 'Everyday utility backpack', tag: 'On the move'
	}
];

const extraProductGroups = [
	{
		category: 'tops',
		items: [
			['District Boxy Tee', 40], ['Side Street Logo Tee', 42], ['After Hours Long Sleeve', 54], ['Warehouse Graphic Tee', 46],
			['Off-Duty Hoodie', 86], ['District Crewneck', 78], ['Late Checkout Zip Hoodie', 92], ['Boxed In Heavy Tee', 44],
			['Good Company Polo', 62], ['Night Shift Overshirt', 88], ['No Signal Thermal', 58], ['Weekend Rugby Shirt', 74],
			['Everyday Tank', 30], ['Mainline Mockneck', 68], ['Block Letter Hoodie', 84], ['Corner Store Tee', 38],
			['City Limits Sweatshirt', 80], ['Artist Series Tee', 48]
		],
		images: ['photo-1521572163474-6864f9cf17ab', 'photo-1620799140408-edc6dcb6d633', 'photo-1551488831-00ddcb6c6bd3', 'photo-1551028719-00167b16eac5', 'photo-1523398002811-999ca8dec234', 'photo-1529139574466-a303027c1d8b', 'photo-1503342217505-b0a15ec3261c', 'photo-1490481651871-ab68de25d43d']
	},
	{
		category: 'bottoms',
		items: [
			['District Relaxed Jean', 92], ['Trackside Cargo Pant', 84], ['Everyday Carpenter Pant', 88], ['Sunday Sweatpant', 68],
			['Straight Shot Denim', 90], ['Transit Nylon Short', 54], ['Wide Awake Trouser', 82], ['Utility Pocket Short', 52],
			['Off Hours Parachute Pant', 96], ['Weekend Chino', 76], ['Double Knee Work Pant', 94], ['After Dark Short', 58],
			['City Runner Jogger', 72], ['Canvas Field Pant', 86], ['Easy Does It Short', 48], ['District Pleated Trouser', 98]
		],
		images: ['photo-1542272604-787c3835535d', 'photo-1515886657613-9f3515b0c78f', 'photo-1503341455253-b2e723bb3dbb', 'photo-1529139574466-a303027c1d8b', 'photo-1475180098004-ca77a66827be']
	},
	{
		category: 'extras',
		items: [
			['District Five-Panel', 34], ['Everywhere Tote', 42], ['Transit Crossbody', 58], ['Good Luck Beanie', 28],
			['Side Street Socks', 16], ['Daily Carry Sling', 48], ['Off Script Bucket Hat', 36], ['Utility Key Clip', 18],
			['Weekend Duffle', 72], ['District Sport Cap', 32], ['Pocket Change Wallet', 38], ['All Day Backpack', 78],
			['After Hours Beanie', 30], ['Market Day Tote', 38], ['Canvas Zip Pouch', 24], ['City Pack Mini', 64]
		],
		images: ['photo-1521369909029-2afed882baee', 'photo-1553062407-98eeb64c6a62', 'photo-1584917865442-de89df76afd3', 'photo-1576566588028-4147f3842f27', 'photo-1512436991641-6745cdb1723f']
	}
];

const colors = ['Washed black', 'Chalk', 'Concrete', 'Olive', 'Rust', 'Midnight'];
const tags = ['Just landed', 'District staple', 'New', 'Easy fit'];

const generatedProducts = extraProductGroups.flatMap((group) => group.items.map(([name, price], index) => ({
	name,
	price,
	category: group.category,
	detail: `${group.category[0].toUpperCase()}${group.category.slice(1)} · ${colors[index % colors.length]}`,
	image: `/assets/products/${group.images[index % group.images.length]}.jpg`,
	imageAlt: name,
	tag: tags[index % tags.length]
})));

export const products = [...baseProducts, ...generatedProducts].map((product, index) => ({
	id: String(index + 1),
	...product
}));
